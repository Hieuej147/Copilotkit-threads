"use client";

import { useRenderTool } from "@copilotkit/react-core/v2";
import { CloudSun, Droplets, MapPin, Thermometer, Wind } from "lucide-react";
import { z } from "zod";
import { agentId } from "../lib/config";

const weatherParameters = z.object({ location: z.string() });

type WeatherResult = {
  location: string;
  condition: string;
  temperatureC: number;
  humidityPercent: number;
  windKph: number;
  isDemo: boolean;
};

function parseResult(result: string): WeatherResult | null {
  try {
    const parsed = JSON.parse(result) as Partial<WeatherResult>;
    if (typeof parsed.location !== "string" || typeof parsed.temperatureC !== "number") return null;
    return parsed as WeatherResult;
  } catch {
    return null;
  }
}

export function WeatherToolRenderer() {
  useRenderTool({
    name: "get_weather",
    agentId,
    parameters: weatherParameters,
    render: ({ status, parameters, result }) => {
      const weather = status === "complete" ? parseResult(result) : null;
      return (
        <section className="weather-tool" aria-label="Weather tool result">
          <div className="weather-tool-head">
            <CloudSun size={20} />
            <div>
              <span className="weather-tool-label">Weather tool</span>
              <strong><MapPin size={14} /> {weather?.location ?? parameters.location ?? "Loading location"}</strong>
            </div>
            <span className="weather-tool-status">{status === "complete" ? "Demo data" : "Running"}</span>
          </div>
          {weather ? (
            <div className="weather-tool-grid">
              <div><Thermometer size={17} /><span>{weather.temperatureC}°C</span></div>
              <div><CloudSun size={17} /><span>{weather.condition}</span></div>
              <div><Droplets size={17} /><span>{weather.humidityPercent}%</span></div>
              <div><Wind size={17} /><span>{weather.windKph} km/h</span></div>
            </div>
          ) : <div className="weather-tool-loading">Fetching hard-coded weather...</div>}
        </section>
      );
    },
  }, []);
  return null;
}
