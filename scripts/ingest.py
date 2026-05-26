#!/usr/bin/env python3
"""
RateCheck ingestion script.

Streams both VOA zip files, filters to Greater Manchester postcode prefixes
(M, SK, OL, BL, WN — all districts, including M90), and bulk-loads into
Supabase Postgres.

Usage:
    pip install -r scripts/requirements.txt
    DATABASE_URL=postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres \
        python3 scripts/ingest.py

DATABASE_URL must be the service-role / superuser connection string.
Expected run time: 7–12 minutes. Expect ~200k–300k list_entries rows.
"""

import csv
import io
import os
import re
import sys
import zipfile
from datetime import datetime
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values

DATA_DIR = Path(__file__).parent.parent / "data"
LIST_ZIP = DATA_DIR / "uk-englandwales-ndr-2026-listentries-compiled-epoch-0001-baseline-csv.zip"
SMV_ZIP  = DATA_DIR / "uk-englandwales-ndr-2026-summaryvaluations-compiled-epoch-0001-baseline-csv.zip"

GM_PREFIXES = {"M", "SK", "OL", "BL", "WN"}

# Lifted verbatim from salford_parades_v3.py — correctly distinguishes M6 from M60
AREA_RE = re.compile(r"^([A-Z]+\d+[A-Z]?)\s*\d[A-Z]{2}$")

BATCH_SIZE = 2000


# ── Postcode helpers ────────────────────────────────────────────────────────────

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


def area_prefix(area):
    m = re.match(r"^([A-Z]+)", area)
    return m.group(1) if m else None


def in_gm(postcode):
    area = get_area(postcode)
    if not area:
        return False, None
    return area_prefix(area) in GM_PREFIXES, area


# ── Field parsers ───────────────────────────────────────────────────────────────

def parse_date(s):
    s = (s or "").strip()
    if not s:
        return None
    try:
        return datetime.strptime(s, "%d-%b-%Y").date()
    except ValueError:
        return None


def parse_int(s):
    s = (s or "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def parse_float(s):
    s = (s or "").strip()
    if not s:
        return None
    try:
        return float(s.lstrip("+").rstrip("%"))
    except ValueError:
        return None


# ── List entries ────────────────────────────────────────────────────────────────

def load_list_entries(conn):
    print(f"Streaming list entries from {LIST_ZIP.name} ...")
    cur = conn.cursor()
    batch = []
    assessment_refs = set()
    total = matched = 0

    def flush():
        execute_values(cur, """
            INSERT INTO list_entries (
                assessment_reference, uarn, ba_reference_number, number_or_name,
                street, town, postcode, postcode_area,
                primary_description_code, primary_description_text,
                scat_code_and_suffix, rateable_value,
                firm_name, full_property_identifier, billing_authority_code,
                effective_date, composite_indicator, appeal_settlement_code,
                list_alteration_date
            ) VALUES %s ON CONFLICT (assessment_reference) DO NOTHING
        """, batch)
        conn.commit()
        batch.clear()

    with zipfile.ZipFile(LIST_ZIP) as zf:
        for name in zf.namelist():
            if not name.lower().endswith(".csv") or "historic" in name.lower():
                continue
            print(f"  {name}")
            with zf.open(name) as f:
                text = io.TextIOWrapper(f, encoding="ascii", errors="replace")
                reader = csv.reader(text, delimiter="*", quoting=csv.QUOTE_NONE)
                for row in reader:
                    total += 1
                    if total % 250_000 == 0:
                        print(f"    {total:,} scanned / {matched:,} matched")
                    if len(row) < 22:
                        continue
                    ok, area = in_gm(row[14])
                    if not ok:
                        continue
                    aref = parse_int(row[19])
                    if aref is None:
                        continue
                    matched += 1
                    assessment_refs.add(aref)
                    batch.append((
                        aref,
                        parse_int(row[6]),                  # uarn
                        row[3].strip() or None,             # ba_reference_number
                        row[9].strip() or None,             # number_or_name
                        row[10].strip() or None,            # street
                        row[11].strip() or None,            # town
                        row[14].strip(),                    # postcode
                        area,                               # postcode_area
                        row[4].strip() or None,             # primary_description_code
                        row[5].strip() or None,             # primary_description_text
                        row[21].strip() or None,            # scat_code_and_suffix
                        parse_int(row[17]),                 # rateable_value
                        row[8].strip() or None,             # firm_name
                        row[7].strip() or None,             # full_property_identifier
                        row[1].strip() or None,             # billing_authority_code
                        parse_date(row[15]),                # effective_date
                        row[16].strip() or None,            # composite_indicator
                        row[18].strip() or None,            # appeal_settlement_code
                        parse_date(row[20]),                # list_alteration_date
                    ))
                    if len(batch) >= BATCH_SIZE:
                        flush()

    if batch:
        flush()
    cur.close()
    print(f"  Done: {total:,} scanned, {matched:,} matched, {len(assessment_refs):,} unique refs")
    return assessment_refs


# ── SMV ─────────────────────────────────────────────────────────────────────────

def load_smv(conn, target_refs):
    print(f"\nStreaming SMV from {SMV_ZIP.name} ...")
    cur = conn.cursor()
    asmt_batch = []
    li_batch   = []
    total = groups = line_items = 0
    current_aref = None
    in_target = False

    def flush_asmt():
        if not asmt_batch:
            return
        execute_values(cur, """
            INSERT INTO smv_assessments (
                assessment_reference, uarn, scheme_reference, scat_code,
                total_area_or_units, adopted_rv, unit_of_measurement, unadjusted_price
            ) VALUES %s ON CONFLICT DO NOTHING
        """, asmt_batch)
        conn.commit()
        asmt_batch.clear()

    def flush_li():
        if not li_batch:
            return
        execute_values(cur, """
            INSERT INTO smv_line_items (
                assessment_reference, line_number, floor_description,
                description, area, price, value
            ) VALUES %s ON CONFLICT DO NOTHING
        """, li_batch)
        conn.commit()
        li_batch.clear()

    with zipfile.ZipFile(SMV_ZIP) as zf:
        for name in zf.namelist():
            if not name.lower().endswith(".csv"):
                continue
            print(f"  {name}")
            with zf.open(name) as f:
                text = io.TextIOWrapper(f, encoding="ascii", errors="replace")
                reader = csv.reader(text, delimiter="*", quoting=csv.QUOTE_NONE)
                for row in reader:
                    total += 1
                    if total % 500_000 == 0:
                        print(f"    {total:,} rows / {groups:,} groups matched")
                    if not row:
                        continue
                    rt = row[0].strip()

                    if rt == "01":
                        if len(row) < 29:
                            in_target = False
                            current_aref = None
                            continue
                        aref = parse_int(row[1])
                        in_target = aref in target_refs
                        current_aref = aref if in_target else None
                        if in_target:
                            groups += 1
                            asmt_batch.append((
                                aref,
                                parse_int(row[2]),
                                parse_int(row[14]),
                                row[26].strip() if len(row) > 26 else None,
                                parse_float(row[16]),
                                parse_int(row[19]),
                                row[27].strip() if len(row) > 27 else None,
                                parse_float(row[28]) if len(row) > 28 else None,
                            ))
                            if len(asmt_batch) >= BATCH_SIZE:
                                flush_asmt()

                    elif rt == "02" and in_target and current_aref is not None:
                        if len(row) < 7:
                            continue
                        line_items += 1
                        li_batch.append((
                            current_aref,
                            parse_int(row[1]),
                            row[2].strip() or None,
                            row[3].strip() or None,
                            parse_float(row[4]),
                            parse_float(row[5]),
                            parse_int(row[6]),
                        ))
                        if len(li_batch) >= BATCH_SIZE:
                            flush_li()

    flush_asmt()
    flush_li()
    cur.close()
    print(f"  Done: {groups:,} assessments, {line_items:,} line items ({total:,} rows scanned)")


# ── Verification ────────────────────────────────────────────────────────────────

def verify(conn):
    cur = conn.cursor()
    print("\n=== Sanity check ===")

    cur.execute("SELECT COUNT(*) FROM list_entries")
    print(f"Total list_entries: {cur.fetchone()[0]:,}")

    cur.execute("""
        SELECT LEFT(primary_description_code, 2) AS code, COUNT(*) AS n
        FROM list_entries WHERE primary_description_code IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10
    """)
    print("\nTop 10 primary_description_code prefixes:")
    for code, n in cur.fetchall():
        print(f"  {code or '??'}: {n:,}")

    cur.execute("""
        SELECT LEFT(postcode_area, 2) AS prefix, COUNT(*) AS n
        FROM list_entries GROUP BY 1 ORDER BY 2 DESC
    """)
    print("\nRow count by postcode prefix:")
    for prefix, n in cur.fetchall():
        print(f"  {prefix}: {n:,}")

    cur.execute("""
        SELECT assessment_reference, number_or_name, street, postcode, rateable_value
        FROM list_entries
        WHERE postcode = 'M30 9PS' AND number_or_name LIKE '225%'
    """)
    rows = cur.fetchall()
    print(f"\n225 Monton Road lookup ({len(rows)} row(s)):")
    for r in rows:
        print(f"  aref={r[0]}, name={r[1]}, street={r[2]}, pc={r[3]}, rv=£{r[4]:,}")

    cur.close()


# ── Entry point ─────────────────────────────────────────────────────────────────

def main():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("ERROR: DATABASE_URL not set.\n"
                 "Export the service-role Postgres connection string before running.")

    for path in [LIST_ZIP, SMV_ZIP]:
        if not path.exists():
            sys.exit(f"ERROR: {path} not found")

    print("Connecting to Postgres ...")
    conn = psycopg2.connect(db_url)
    conn.autocommit = False

    try:
        refs = load_list_entries(conn)
        load_smv(conn, refs)
        verify(conn)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
