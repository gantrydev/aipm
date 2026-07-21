const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/+$/, "");

export type MeResponse = {
  user: { id: string; githubLogin: string };
  workspaces: Array<{
    id: string;
    name: string;
    role: string;
    githubAccountLogin: string | null;
  }>;
  slack: { available: boolean; status: string };
  csrfToken: string;
};

export const apiUrl = (path: string) => `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;

export const authGithubUrl = (returnTo?: string) => {
  const base = apiUrl("/auth/github");
  if (!returnTo) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}returnTo=${encodeURIComponent(returnTo)}`;
};

export async function fetchMe(): Promise<MeResponse | null> {
  const res = await fetch(apiUrl("/api/me"), { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`me_failed:${res.status}`);
  return (await res.json()) as MeResponse;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { credentials: "include" });
  if (!res.ok) throw new Error(`get_failed:${res.status}:${path}`);
  return (await res.json()) as T;
}

export async function apiMutate<T>(
  path: string,
  method: "POST" | "PUT",
  csrfToken: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`mutate_failed:${res.status}:${path}`);
  return (await res.json()) as T;
}
