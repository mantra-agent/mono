-- Terminal retirement of the overbuilt post-deploy Regression product domain.
-- Ordinary post-build checking now runs through Timer -> Skill -> Issues.

BEGIN;

SELECT pg_advisory_xact_lock(1380405828::int4, 1::int4);

DROP TABLE IF EXISTS issue_regression_results;
DROP TABLE IF EXISTS issue_regression_contracts;
DROP TABLE IF EXISTS regression_runs;
DROP FUNCTION IF EXISTS prevent_issue_regression_result_mutation();

COMMIT;
