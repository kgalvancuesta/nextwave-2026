export type DashboardView = "orders" | "phone";

export function dashboardViewFromSearch(search: string): DashboardView {
  return new URLSearchParams(search).get("view") === "phone" ? "phone" : "orders";
}
