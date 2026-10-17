import { alertBreakerTrips } from "@/lib/edge/breakers";

// Tells the operators in Discord of each site statement the mini paused
// after the runtime stopped it repeatedly. See lib/edge/breakers.ts.
async function main() {
  const { sites, alerted } = await alertBreakerTrips();
  if (alerted)
    console.log(
      `[edge-breaker-alerts] ${alerted} pause(s) on ${sites} site(s)`,
    );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[edge-breaker-alerts] fatal:", error);
    process.exit(1);
  });
