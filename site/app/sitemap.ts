import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const SITE_URL = "https://aipm.dev";

const sitemap = (): MetadataRoute.Sitemap => {
  return [{ url: `${SITE_URL}/` }];
};

export default sitemap;
