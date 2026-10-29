/**
 * Paged listings from a Gitea or Forgejo destination.
 *
 * Both servers size pages by `limit`, capped at MAX_RESPONSE_ITEMS (50 unless
 * an admin changed it), and ignore `per_page` on most endpoints. Asking for 100
 * releases with `per_page` got 30 back, so a loop that stopped on a short page
 * only ever saw the newest 30. Pages are asked for with `limit` and a listing
 * ends once `X-Total-Count` is reached; without that header, on a short page.
 */

import { httpGet } from "./http-client";

export const DESTINATION_PAGE_SIZE = 50;

// A server that ignores `page` would otherwise be listed forever.
const MAX_PAGES = 1000;

export interface DestinationListing<T> {
  items: T[];
  /** False when a page failed; `items` then holds the pages before it. */
  complete: boolean;
  /** True when `max` stopped the listing while more items remained. */
  truncated: boolean;
}

/** Every item of a paged destination endpoint. `url` must not carry a query. */
export async function listDestinationPages<T = unknown>({
  url,
  token,
  max,
}: {
  url: string;
  token: string;
  /** Stop once this many items are listed. */
  max?: number;
}): Promise<DestinationListing<T>> {
  const items: T[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await httpGet<T[]>(`${url}?limit=${DESTINATION_PAGE_SIZE}&page=${page}`, {
      Authorization: `token ${token}`,
    }).catch(() => null);
    const batch = response?.data;
    if (!Array.isArray(batch)) return { items, complete: false, truncated: false };
    if (batch.length === 0) return { items, complete: true, truncated: false };

    items.push(...batch);

    const totalHeader = response?.headers?.get?.("x-total-count");
    const total = totalHeader ? Number(totalHeader) : NaN;
    const done = Number.isFinite(total) ? items.length >= total : batch.length < DESTINATION_PAGE_SIZE;

    if (max !== undefined && items.length >= max) {
      return {
        items: items.slice(0, max),
        complete: true,
        truncated: done ? items.length > max : true,
      };
    }
    if (done) return { items, complete: true, truncated: false };
  }

  return { items, complete: false, truncated: false };
}

function apiBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/v1`;
}

/** Every release the destination holds for one repository. */
export async function listDestinationReleases<T = unknown>({
  baseUrl,
  token,
  owner,
  repo,
  max,
}: {
  baseUrl: string;
  token: string;
  owner: string;
  repo: string;
  max?: number;
}): Promise<DestinationListing<T>> {
  return listDestinationPages<T>({
    url: `${apiBase(baseUrl)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`,
    token,
    max,
  });
}

/**
 * Every repository of one destination owner the token can see, private ones
 * included. Works for users and organizations alike.
 */
export async function listDestinationOwnerRepositories<T = unknown>({
  baseUrl,
  token,
  owner,
}: {
  baseUrl: string;
  token: string;
  owner: string;
}): Promise<DestinationListing<T>> {
  return listDestinationPages<T>({
    url: `${apiBase(baseUrl)}/users/${encodeURIComponent(owner)}/repos`,
    token,
  });
}
