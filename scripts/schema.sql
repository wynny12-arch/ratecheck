-- RateCheck schema — run this in the Supabase SQL editor before running ingest.py

-- ── Data tables ────────────────────────────────────────────────────────────────

CREATE TABLE list_entries (
    assessment_reference BIGINT PRIMARY KEY,
    uarn                 BIGINT,
    ba_reference_number  VARCHAR,
    number_or_name       VARCHAR,
    street               VARCHAR,
    town                 VARCHAR,
    postcode             VARCHAR,
    postcode_area        VARCHAR,
    primary_description_code VARCHAR,
    primary_description_text VARCHAR,
    scat_code_and_suffix VARCHAR,
    rateable_value       BIGINT,
    firm_name            VARCHAR,
    full_property_identifier VARCHAR,
    billing_authority_code   VARCHAR,
    effective_date       DATE,
    composite_indicator  VARCHAR(1),
    appeal_settlement_code   VARCHAR,
    list_alteration_date DATE
);

CREATE INDEX idx_le_uarn     ON list_entries(uarn);
CREATE INDEX idx_le_postcode ON list_entries(postcode);
CREATE INDEX idx_le_street   ON list_entries(UPPER(street));
CREATE INDEX idx_le_pdc      ON list_entries(primary_description_code);
CREATE INDEX idx_le_scat     ON list_entries(scat_code_and_suffix);
CREATE INDEX idx_le_area     ON list_entries(postcode_area);

CREATE TABLE smv_assessments (
    assessment_reference BIGINT PRIMARY KEY REFERENCES list_entries(assessment_reference),
    uarn                 BIGINT,
    scheme_reference     BIGINT,
    scat_code            VARCHAR,
    total_area_or_units  DOUBLE PRECISION,
    adopted_rv           BIGINT,
    unit_of_measurement  VARCHAR,
    unadjusted_price     DOUBLE PRECISION
);

CREATE INDEX idx_smva_scheme ON smv_assessments(scheme_reference);
CREATE INDEX idx_smva_scat   ON smv_assessments(scat_code);

CREATE TABLE smv_line_items (
    assessment_reference BIGINT REFERENCES smv_assessments(assessment_reference),
    line_number          INTEGER,
    floor_description    VARCHAR,
    description          VARCHAR,
    area                 DOUBLE PRECISION,
    price                DOUBLE PRECISION,
    value                BIGINT,
    PRIMARY KEY (assessment_reference, line_number)
);

CREATE INDEX idx_smvli_aref ON smv_line_items(assessment_reference);

-- ── Feedback tables ────────────────────────────────────────────────────────────

CREATE TABLE query_log (
    id            BIGSERIAL PRIMARY KEY,
    user_email    TEXT,
    question      TEXT,
    generated_sql TEXT,
    row_count     INTEGER,
    succeeded     BOOLEAN,
    error_message TEXT,
    explanation   TEXT,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE query_feedback (
    id           BIGSERIAL PRIMARY KEY,
    query_log_id BIGINT REFERENCES query_log(id),
    thumbs_up    BOOLEAN,
    comment      TEXT,
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- ── Read-only role ─────────────────────────────────────────────────────────────
-- Replace <READONLY_PASSWORD> with a strong random password (keep it — you'll need
-- it for DATABASE_URL_READONLY in the Next.js env vars).

CREATE ROLE ratecheck_readonly WITH LOGIN PASSWORD '<READONLY_PASSWORD>';
GRANT CONNECT ON DATABASE postgres TO ratecheck_readonly;
GRANT USAGE ON SCHEMA public TO ratecheck_readonly;
GRANT SELECT ON list_entries, smv_assessments, smv_line_items TO ratecheck_readonly;
GRANT INSERT ON query_log, query_feedback TO ratecheck_readonly;
GRANT USAGE, SELECT ON SEQUENCE query_log_id_seq     TO ratecheck_readonly;
GRANT USAGE, SELECT ON SEQUENCE query_feedback_id_seq TO ratecheck_readonly;
