"use client";

import createGlobe from "cobe";
import { useEffect, useRef } from "react";
import { Card } from "@/components/ui/card";

export type MarkerTone = "red" | "yellow" | "green";

export interface ActiveCallMarker {
  callId: string;
  label: string;
  location: [number, number]; // [lat, lon]
  status?: string;
  detail?: string | null;
  tone?: MarkerTone;
}

const DISPLAY = 232;
const DPR = 2;

/** cobe takes colours as 0-1 RGB triples, so the brand hexes are pre-converted. */
const TONE_RGB: Record<MarkerTone, [number, number, number]> = {
  red: [0.847, 0.314, 0.247], // #D8503F
  yellow: [0.91, 0.639, 0.239], // #E8A33D
  green: [0.059, 0.478, 0.302], // #0F7A4D
};

const TONE_HEX: Record<MarkerTone, string> = {
  red: "#D8503F",
  yellow: "#E8A33D",
  green: "#0F7A4D",
};

const BRAND_RGB: [number, number, number] = [0.165, 0.471, 0.918]; // #2A78EA

/**
 * Placeholder ports shown only while no call is live, so the panel reads as a
 * map instead of an empty sphere. Real active calls replace these entirely.
 */
const DEMO_MARKERS: ActiveCallMarker[] = [
  { callId: "demo-long-beach", label: "Long Beach", location: [33.77, -118.19], detail: "Needs attention", tone: "red" },
  { callId: "demo-manzanillo", label: "Manzanillo", location: [19.05, -104.32], detail: "Needs attention", tone: "red" },
  { callId: "demo-houston", label: "Houston", location: [29.76, -95.37], detail: "Negotiating", tone: "yellow" },
  { callId: "demo-veracruz", label: "Veracruz", location: [19.17, -96.13], detail: "Booked", tone: "green" },
  { callId: "demo-santos", label: "Santos", location: [-23.96, -46.33], detail: "Booked", tone: "green" },
  { callId: "demo-callao", label: "Callao", location: [-12.05, -77.14], detail: "Negotiating", tone: "yellow" },
  { callId: "demo-buenos-aires", label: "Buenos Aires", location: [-34.6, -58.38], detail: "Negotiating", tone: "yellow" },
  { callId: "demo-rotterdam", label: "Rotterdam", location: [51.92, 4.48], detail: "Needs attention", tone: "red" },
  { callId: "demo-hamburg", label: "Hamburg", location: [53.55, 9.99], detail: "Booked", tone: "green" },
  { callId: "demo-algeciras", label: "Algeciras", location: [36.13, -5.45], detail: "Booked", tone: "green" },
  { callId: "demo-shanghai", label: "Shanghai", location: [31.23, 121.47], detail: "Negotiating", tone: "yellow" },
  { callId: "demo-singapore", label: "Singapore", location: [1.35, 103.82], detail: "Booked", tone: "green" },
  { callId: "demo-jebel-ali", label: "Jebel Ali", location: [25.01, 55.06], detail: "Booked", tone: "green" },
  { callId: "demo-durban", label: "Durban", location: [-29.86, 31.02], detail: "Needs attention", tone: "red" },
  { callId: "demo-tangier", label: "Tangier", location: [35.79, -5.81], detail: "Booked", tone: "green" },
  { callId: "demo-sydney", label: "Sydney", location: [-33.87, 151.21], detail: "Booked", tone: "green" },
  { callId: "demo-melbourne", label: "Melbourne", location: [-37.81, 144.96], detail: "Booked", tone: "green" },
];

const TONE_ORDER: Record<MarkerTone, number> = { red: 0, yellow: 1, green: 2 };

const LEGEND_LIMIT = 4;
/** Urgency-weighted, but every tone gets a row so the colour coding explains itself. */
const LEGEND_QUOTA: Array<[MarkerTone, number]> = [["red", 2], ["yellow", 1], ["green", 1]];

/** Spreads `count` picks across `list` instead of taking the first N, which would
 *  otherwise surface four ports from whichever region happens to be listed first. */
function spread<T>(list: T[], count: number): T[] {
  if (list.length <= count) return list;
  const at = (i: number) => list.slice(i, i + 1); // slice keeps this safe under noUncheckedIndexedAccess
  if (count === 1) return at(Math.floor(list.length / 2));
  return Array.from({ length: count }, (_, i) => Math.floor((i * list.length) / count)).flatMap(at);
}

/** Legend shows a compact, representative sample so the card stays ~4 rows tall. */
function legendMarkers(markers: ActiveCallMarker[]): ActiveCallMarker[] {
  const picked: ActiveCallMarker[] = [];
  for (const [tone, quota] of LEGEND_QUOTA) {
    picked.push(...spread(markers.filter((m) => m.tone === tone), quota));
  }
  // Backfill from anything not already shown (untoned or short-quota tones).
  if (picked.length < LEGEND_LIMIT) {
    const shown = new Set(picked.map((m) => m.callId));
    picked.push(...markers.filter((m) => !shown.has(m.callId)).slice(0, LEGEND_LIMIT - picked.length));
  }
  return picked
    .slice(0, LEGEND_LIMIT)
    .sort((a, b) => (a.tone ? TONE_ORDER[a.tone] : 3) - (b.tone ? TONE_ORDER[b.tone] : 3));
}

export function GlobalCallGlobe({ markers }: { markers: ActiveCallMarker[] }) {
  const displayMarkers = markers.length > 0 ? markers : DEMO_MARKERS;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phiRef = useRef(0);
  const globeRef = useRef<ReturnType<typeof createGlobe> | null>(null);
  const frameRef = useRef<number | null>(null);

  // Rebuilt only when the marker set actually changes, not on every 1.5s poll.
  const markerKey = displayMarkers.map((m) => `${m.callId}:${m.tone ?? ""}`).join("|");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const globe = createGlobe(canvas, {
      devicePixelRatio: DPR,
      width: DISPLAY * DPR,
      height: DISPLAY * DPR,
      phi: phiRef.current,
      theta: 0.22,
      dark: 0,
      diffuse: 1.1,
      mapSamples: 16000,
      mapBrightness: 5.2,
      baseColor: [0.86, 0.88, 0.93],
      markerColor: BRAND_RGB,
      glowColor: [1, 1, 1],
      markers: displayMarkers.map((marker) => ({
        location: marker.location,
        size: 0.06,
        ...(marker.tone ? { color: TONE_RGB[marker.tone] } : {}),
      })),
    });
    globeRef.current = globe;

    const tick = () => {
      phiRef.current += 0.004;
      globe.update({ phi: phiRef.current });
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      globe.destroy();
      globeRef.current = null;
    };
  }, [markerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card className="overflow-hidden rounded-[14px] border-[var(--line)] bg-white p-4 shadow-none">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[15px] font-semibold tracking-tight text-[var(--ink)]">Global call activity</p>
        <span className="text-[12px] text-[var(--muted-text)]">{displayMarkers.length} active</span>
      </div>

      <div className="py-1">
        <div className="mx-auto" style={{ width: DISPLAY, height: DISPLAY, maxWidth: "100%" }}>
          <canvas
            ref={canvasRef}
            width={DISPLAY * DPR}
            height={DISPLAY * DPR}
            style={{ width: "100%", height: "100%", display: "block", aspectRatio: "1" }}
          />
        </div>
      </div>

      <ul className="space-y-1.5 border-t border-[var(--line)] pt-3">
        {legendMarkers(displayMarkers).map((marker) => {
          const sub = marker.detail ?? marker.status ?? null;
          return (
            <li key={marker.callId} className="flex items-center gap-2 text-[12.5px]">
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: marker.tone ? TONE_HEX[marker.tone] : "#2A78EA" }}
              />
              <span className="min-w-0 flex-1 truncate font-medium text-[var(--ink)]">{marker.label}</span>
              {sub ? <span className="shrink-0 text-[var(--muted-text)]">{sub}</span> : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
