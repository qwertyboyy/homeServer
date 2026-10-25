import { NextResponse, type NextRequest } from "next/server";

// Optimistic check only: the API validates the session on every request.
export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has("nif_session");
  const { pathname, search } = request.nextUrl;

  if (pathname === "/login") {
    return hasSession ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (!hasSession) {
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon.ico|icon.svg).*)"],
};
