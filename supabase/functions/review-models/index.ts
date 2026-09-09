import { handleFunction } from "../_shared/http.ts";
import { reviewScope } from "../_shared/review-schedule.ts";
import { requiredRpc } from "../_shared/rpc.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import { iso } from "../_shared/time.ts";
import { loadWatchlist } from "../_shared/watchlist.ts";

Deno.serve((request) => handleFunction(request, async () => {
  const client = createAdminClient();
  const scope = reviewScope(await loadWatchlist(client), Date.now());
  if (!scope) return { ok: true, status: "empty-watchlist" };
  const review = await requiredRpc(client, "review_and_promote_challengers", {
    p_as_of: iso(Date.now()),
    p_symbol: scope.asset.symbol,
    p_timeframe: scope.timeframe,
    p_min_resolved: 500,
    p_z_margin: 1.96,
  });
  return { ok: true, symbol: scope.asset.symbol, timeframe: scope.timeframe, review };
}));
