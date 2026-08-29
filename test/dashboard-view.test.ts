import { describe, expect, it } from "vitest";
import { dashboardViewFromSearch } from "@/lib/dashboard-view";

describe("dashboard navigation", () => {
  it("defaults to orders and restores the phone view from the URL", () => {
    expect(dashboardViewFromSearch("")).toBe("orders");
    expect(dashboardViewFromSearch("?view=orders")).toBe("orders");
    expect(dashboardViewFromSearch("?view=phone")).toBe("phone");
  });
});
