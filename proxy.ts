import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const hostname = (forwardedHost || request.nextUrl.hostname).split(":")[0]!.toLowerCase();
  const local = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  const password = process.env.DASHBOARD_PASSWORD;

  if (!password && local) return NextResponse.next();
  if (!password) {
    return new NextResponse("Set DASHBOARD_PASSWORD before accessing Marketline through a public tunnel.", { status: 503 });
  }

  const username = process.env.DASHBOARD_USERNAME || "marketline";
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Basic ")) {
    try {
      const decoded = atob(authorization.slice(6));
      const separator = decoded.indexOf(":");
      if (decoded.slice(0, separator) === username && decoded.slice(separator + 1) === password) {
        return NextResponse.next();
      }
    } catch {
      // Fall through to the authentication challenge.
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Marketline", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/", "/api/contacts/:path*", "/api/calls/:path*", "/api/orders/:path*", "/api/markets/:path*", "/api/offers/:path*", "/api/commitments/:path*"],
};
