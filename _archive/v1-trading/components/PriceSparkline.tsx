"use client";

import React from "react";
import {
  LineChart,
  Line,
  ResponsiveContainer,
} from "recharts";

export type PricePoint = {
  time: number;  // timestamp ms
  price: number;
};

interface PriceSparklineProps {
  data: PricePoint[];
}

export function PriceSparkline({ data }: PriceSparklineProps) {
  if (!data || data.length === 0) return null;

  return (
    <div className="sparkline-wrapper">
      <ResponsiveContainer width="100%" height={60}>
        <LineChart data={data}>
          <Line
            type="monotone"
            dataKey="price"
            dot={false}
            strokeWidth={1.5}
            // no need to specify color; Recharts will pick a default
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
