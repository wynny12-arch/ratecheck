"""
Re-ingest with NO primary description code filter.

This time we want everything in the target postcodes regardless of property
type. We'll then categorise by description code in the queries to see the
true property type mix.

Run: python3 salford_parades_v3.py
"""

import csv
import io
import re
import sys
import zipfile
from pathlib import Path
from datetime import datetime

import duckdb

DATA_DIR = Path(__file__).parent / "data"
DB_PATH = Path(__file__).parent / "salford_full.duckdb"

LIST_ENTRIES_ZIP = DATA_DIR / "uk-englandwales-ndr-2026-listentries-compiled-epoch-0001-baseline-csv.zip"
SMV_ZIP = DATA_DIR / "uk-englandwales-ndr-2026-summaryvaluations-compiled-epoch-0001-baseline-csv.zip"

TARGET_AREAS = {"M30", "M28", "M27", "M6", "M44"}

AREA_RE = re.compile(r"^([A-Z]+\d+[A-Z]?)\s*\d[A-Z]{2}$")


def get_area(postcode):
    if not postcode:
        return None
    pc = postcode.strip().upper()
    m = AREA_RE.match(pc)
    if not m:
        compact = pc.replace(" ", "")
        if len(compact) >= 5:
            spaced = compact[:-3] + " " + compact[-3:]
            m = AREA_RE.match(spaced)
        if not m:
            return None
    return m.group(1)


def parse_date(s):
    s = s.strip()
    if not s:
        return None
    try:
        return datetime.strptime(s, "%d-%b-%Y").date()
    except ValueError:
        return None


def parse_int(s):
    s = s.strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def parse_float(s):
    s = s.strip()
    if not s:
        return None
    s = s.lstrip("+").rstrip("%")
    try:
        return float(s)
    except ValueError:
        return None


def filter_list_entries(zip_path):
    print(f"\nFiltering list entries from {zip_path.name}...")
    matched = []
    total = 0

    with zipfile.ZipFile(zip_path) as zf:
        for name in zf.namelist():
            if not name.lower().endswith(".csv"):
                continue
            if "historic" in name.lower():
                continue

            print(f"  Reading {name}")
            with zf.open(name) as f:
                text = io.TextIOWrapper(f, encoding="ascii", errors="replace")
                reader = csv.reader(text, delimiter="*", quoting=csv.QUOTE_NONE)
                for row in reader:
                    total += 1
                    if total % 250_000 == 0:
                        print(f"    {total:,} rows scanned, {len(matched):,} matched")

                    if len(row) < 23:
                        continue

                    postcode = row[14]
                    area = get_area(postcode)
                    if area not in TARGET_AREAS:
                        continue

                    # No description code filter this time

                    matched.append({
                        "billing_authority_code": row[1].strip(),
                        "ba_reference_number": row[3].strip(),
                        "primary_description_code": row[4].strip(),
                        "primary_description_text": row[5].strip(),
                        "uarn": parse_int(row[6]),
                        "full_property_identifier": row[7].strip(),
                        "firm_name": row[8].strip() or None,
                        "number_or_name": row[9].strip() or None,
                        "street": row[10].strip(),
                        "town": row[11].strip(),
                        "postal_district": row[12].strip(),
                        "county": row[13].strip(),
                        "postcode": postcode.strip(),
                        "postcode_area": area,
                        "effective_date": parse_date(row[15]),
                        "composite_indicator": row[16].strip() or None,
                        "rateable_value": parse_int(row[17]),
                        "appeal_settlement_code": row[18].strip() or None,
                        "assessment_reference": parse_int(row[19]),
                        "list_alteration_date": parse_date(row[20]),
                        "scat_code_and_suffix": row[21].strip(),
                    })

    print(f"  Done. {total:,} total rows scanned, {len(matched):,} matched.")
    return matched


def filter_summary_valuations(zip_path, target_assessment_refs):
    print(f"\nFiltering summary valuations from {zip_path.name}...")
    print(f"  Looking for {len(target_assessment_refs):,} assessment refs")
    target_set = set(target_assessment_refs)
    matched_groups = []
    total = 0
    current_group = None
    in_target = False

    def flush():
        nonlocal current_group
        if current_group and in_target:
            matched_groups.append(current_group)
        current_group = None

    with zipfile.ZipFile(zip_path) as zf:
        for name in zf.namelist():
            if not name.lower().endswith(".csv"):
                continue
            print(f"  Reading {name}")
            with zf.open(name) as f:
                text = io.TextIOWrapper(f, encoding="ascii", errors="replace")
                reader = csv.reader(text, delimiter="*", quoting=csv.QUOTE_NONE)
                for row in reader:
                    total += 1
                    if total % 500_000 == 0:
                        print(f"    {total:,} rows scanned, {len(matched_groups):,} matched")

                    if not row:
                        continue
                    rt = row[0].strip()

                    if rt == "01":
                        flush()
                        if len(row) < 29:
                            current_group = None
                            in_target = False
                            continue
                        aref = parse_int(row[1])
                        in_target = aref in target_set
                        if in_target:
                            current_group = {
                                "assessment": {
                                    "assessment_reference": aref,
                                    "uarn": parse_int(row[2]),
                                    "scheme_reference": parse_int(row[14]),
                                    "primary_description_text": row[15].strip(),
                                    "total_area_or_units": parse_float(row[16]),
                                    "adopted_rv": parse_int(row[19]),
                                    "scat_code": row[26].strip() if len(row) > 26 else "",
                                    "unit_of_measurement": row[27].strip() if len(row) > 27 else "",
                                    "unadjusted_price": parse_float(row[28]) if len(row) > 28 else None,
                                },
                                "line_items": [],
                            }
                    elif not in_target or current_group is None:
                        continue
                    elif rt == "02":
                        if len(row) < 7:
                            continue
                        current_group["line_items"].append({
                            "line_number": parse_int(row[1]),
                            "floor_description": row[2].strip(),
                            "description": row[3].strip(),
                            "area": parse_float(row[4]),
                            "price": parse_float(row[5]),
                            "value": parse_int(row[6]),
                        })

        flush()

    print(f"  Done. {total:,} rows, {len(matched_groups):,} groups matched.")
    return matched_groups


def load_into_duckdb(list_entries, smv_groups, db_path):
    print(f"\nLoading into {db_path}...")
    if db_path.exists():
        db_path.unlink()

    con = duckdb.connect(str(db_path))
    con.execute("""
        CREATE TABLE list_entries (
            uarn BIGINT,
            assessment_reference BIGINT,
            ba_reference_number VARCHAR,
            number_or_name VARCHAR,
            street VARCHAR,
            town VARCHAR,
            postcode VARCHAR,
            postcode_area VARCHAR,
            primary_description_code VARCHAR,
            primary_description_text VARCHAR,
            scat_code_and_suffix VARCHAR,
            rateable_value BIGINT,
            firm_name VARCHAR,
            full_property_identifier VARCHAR,
            billing_authority_code VARCHAR
        );
        CREATE TABLE smv_assessments (
            assessment_reference BIGINT PRIMARY KEY,
            uarn BIGINT,
            scheme_reference BIGINT,
            scat_code VARCHAR,
            total_area_or_units DOUBLE,
            adopted_rv BIGINT,
            unit_of_measurement VARCHAR,
            unadjusted_price DOUBLE
        );
        CREATE TABLE smv_line_items (
            assessment_reference BIGINT,
            line_number INTEGER,
            floor_description VARCHAR,
            description VARCHAR,
            area DOUBLE,
            price DOUBLE,
            value BIGINT
        );
    """)

    if list_entries:
        con.executemany(
            """INSERT INTO list_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [(e["uarn"], e["assessment_reference"], e["ba_reference_number"],
              e["number_or_name"], e["street"], e["town"], e["postcode"],
              e["postcode_area"], e["primary_description_code"],
              e["primary_description_text"], e["scat_code_and_suffix"],
              e["rateable_value"], e["firm_name"], e["full_property_identifier"],
              e["billing_authority_code"]) for e in list_entries],
        )

    for g in smv_groups:
        a = g["assessment"]
        con.execute(
            """INSERT INTO smv_assessments VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (a["assessment_reference"], a["uarn"], a["scheme_reference"],
             a["scat_code"], a["total_area_or_units"], a["adopted_rv"],
             a["unit_of_measurement"], a["unadjusted_price"]),
        )
        for li in g["line_items"]:
            con.execute(
                """INSERT INTO smv_line_items VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (a["assessment_reference"], li["line_number"],
                 li["floor_description"], li["description"], li["area"],
                 li["price"], li["value"]),
            )

    con.close()
    print(f"  Loaded {len(list_entries):,} list entries, {len(smv_groups):,} SMV groups")


def run_queries(db_path):
    print(f"\n=== Full property-type sweep ===\n")
    con = duckdb.connect(str(db_path), read_only=True)

    print("=" * 100)
    print("1. Property type distribution across the five postcode areas")
    print("=" * 100)
    con.sql("""
        SELECT
            primary_description_code AS code,
            primary_description_text AS description,
            COUNT(*) AS n,
            ROUND(AVG(rateable_value)) AS avg_rv
        FROM list_entries
        GROUP BY 1, 2
        ORDER BY n DESC
        LIMIT 40
    """).show(max_rows=50, max_width=200)

    print()
    print("=" * 100)
    print("2. Monton Road FULL picture - every property regardless of type")
    print("=" * 100)
    con.sql("""
        SELECT
            number_or_name AS unit,
            postcode,
            primary_description_code AS code,
            primary_description_text AS description,
            rateable_value AS rv,
            scat_code_and_suffix AS scat
        FROM list_entries
        WHERE UPPER(street) LIKE '%MONTON ROAD%'
        ORDER BY TRY_CAST(REGEXP_EXTRACT(number_or_name, '\\d+') AS INTEGER) NULLS LAST
    """).show(max_rows=120, max_width=200)

    print()
    print("=" * 100)
    print("3. Pantasia / 247-251 if it's now visible")
    print("=" * 100)
    con.sql("""
        SELECT
            le.uarn,
            le.number_or_name,
            le.postcode,
            le.rateable_value AS rv,
            le.primary_description_code AS code,
            le.primary_description_text AS description,
            sa.scheme_reference,
            sa.total_area_or_units AS area_sqm,
            sa.unit_of_measurement AS unit_meas,
            sa.unadjusted_price AS psm
        FROM list_entries le
        LEFT JOIN smv_assessments sa USING (assessment_reference)
        WHERE UPPER(le.street) LIKE '%MONTON ROAD%'
          AND (
              TRY_CAST(REGEXP_EXTRACT(le.number_or_name, '\\d+') AS INTEGER) BETWEEN 247 AND 252
              OR UPPER(le.number_or_name) LIKE '%PANTASIA%'
          )
        ORDER BY TRY_CAST(REGEXP_EXTRACT(le.number_or_name, '\\d+') AS INTEGER)
    """).show(max_rows=15, max_width=200)

    print()
    print("=" * 100)
    print("4. Property type mix on Monton Road specifically")
    print("=" * 100)
    con.sql("""
        SELECT
            primary_description_text AS description,
            COUNT(*) AS n,
            ROUND(MEDIAN(rateable_value)) AS median_rv,
            ROUND(MIN(rateable_value)) AS min_rv,
            ROUND(MAX(rateable_value)) AS max_rv
        FROM list_entries
        WHERE UPPER(street) LIKE '%MONTON ROAD%'
        GROUP BY 1
        ORDER BY n DESC
    """).show(max_rows=30, max_width=200)

    con.close()


def main():
    if not LIST_ENTRIES_ZIP.exists() or not SMV_ZIP.exists():
        print("ERROR: zip files missing")
        sys.exit(1)

    list_entries = filter_list_entries(LIST_ENTRIES_ZIP)
    if not list_entries:
        sys.exit(0)

    target_refs = {e["assessment_reference"] for e in list_entries if e["assessment_reference"]}
    smv_groups = filter_summary_valuations(SMV_ZIP, target_refs)

    load_into_duckdb(list_entries, smv_groups, DB_PATH)
    run_queries(DB_PATH)


if __name__ == "__main__":
    main()
