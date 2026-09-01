-- PostgreSQL requires a newly-added enum value to be committed before another
-- migration can safely reference it. Keep this migration isolated: no BEGIN,
-- no function replacement, and no data write follows the ALTER TYPE here.

alter type signal_atlas.timeframe_code add value if not exists 'M30' after 'M15';

comment on type signal_atlas.timeframe_code is
  'Cloud analysis timeframes. M30 was added prospectively on 2026-08-30.';
