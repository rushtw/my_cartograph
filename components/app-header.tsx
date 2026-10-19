import Link from "next/link";
import { cookies } from "next/headers";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import { ThemeControl } from "./theme-control";

// The one bar above every page: the name, and the theme.
export async function AppHeader() {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      <Link href="/" className="font-mono text-xs font-semibold tracking-tight hover:underline">
        cartograph
      </Link>
      <div className="ml-auto">
        <ThemeControl initial={theme} />
      </div>
    </header>
  );
}
