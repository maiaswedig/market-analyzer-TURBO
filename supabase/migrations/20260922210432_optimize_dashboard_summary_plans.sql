-- Scoped planner settings: avoid tens of thousands of repeated index probes
-- in historical summaries. No data cache or global setting is introduced.
begin;
set local lock_timeout='3s';
alter function signal_atlas.cloud_single_paper_summary_rows() set enable_nestloop=off;
alter function signal_atlas.cloud_single_paper_summary_rows() set work_mem='8MB';
alter function signal_atlas.cloud_single_quality_paper_summary_rows() set enable_nestloop=off;
alter function signal_atlas.cloud_single_quality_paper_summary_rows() set work_mem='8MB';
alter function signal_atlas.cloud_opportunities_rows() set enable_nestloop=off;
alter function signal_atlas.cloud_opportunities_rows() set work_mem='8MB';
commit;
