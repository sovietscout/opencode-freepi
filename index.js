/** free-pi server half — reserved for future server-side hooks. */
import { appendFileSync } from "node:fs";
export default {
  id: "freepi",
  setup: (api) => {
    if (process.env.FREEPI_METER_DEBUG) {
      try {
        api.event.subscribe(({ event }) => {
          const t = event?.type ?? "?";
          if (/error|execution|step|message\.updated|message\.part\.updated/.test(t)) {
            try { appendFileSync("/tmp/freepi-events.log", t + " " + JSON.stringify(event).slice(0, 400) + "\n"); } catch {}
          }
        });
      } catch {}
    }
    return {};
  },
};
