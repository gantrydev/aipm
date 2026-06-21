import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import "./globals.css";

const jetbrainsMono = localFont({
  src: [
    { path: "./fonts/jetbrains-mono-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/jetbrains-mono-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/jetbrains-mono-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-jetbrains",
  display: "swap",
});

const SITE_URL = "https://aipm.dev";
const ORG_URL = "https://gantrydev.com";
const TITLE = "aipm · it drafts, you approve";
const DESCRIPTION =
  "a suggest-only work bot. it watches GitHub and Slack threads, finds who owes an action, and drafts a nudge to their dm. a human approves with one reaction.";

const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  alternates: {
    canonical: "/",
    types: {
      "text/markdown": "/index.md",
    },
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "aipm",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#org`,
      name: "Gantry",
      url: ORG_URL,
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: "aipm",
      description: DESCRIPTION,
      publisher: { "@id": `${SITE_URL}/#org` },
    },
    {
      "@type": "SoftwareApplication",
      name: "aipm",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Cloudflare Workers",
      description: DESCRIPTION,
      url: SITE_URL,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@id": `${SITE_URL}/#org` },
    },
  ],
};

const jsonLdHtml = JSON.stringify(JSON_LD).replace(/</g, "\\u003c");

const RootLayout = (props: { children: ReactNode }) => {
  return (
    <html lang="en" className={jetbrainsMono.variable}>
      <body className="font-sans antialiased">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml }} />
        {props.children}
      </body>
    </html>
  );
};

export { metadata };
export default RootLayout;
