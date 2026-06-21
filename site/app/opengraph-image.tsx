import { ImageResponse } from "next/og";

export const dynamic = "force-static";

const alt = "aipm · it drafts, you approve";
const size = { width: 1200, height: 630 };
const contentType = "image/png";

const TAGS = ["suggest-only", "low-noise", "deterministic", "off-by-default"];

const Image = () => {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: "#080a11",
        backgroundImage:
          "radial-gradient(900px 500px at 85% -10%, rgba(109,140,255,0.35), transparent), radial-gradient(700px 500px at 0% 110%, rgba(63,222,208,0.18), transparent)",
        padding: "72px",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 52,
            height: 52,
            borderRadius: 14,
            background: "linear-gradient(135deg, #8aa0ff, #b486ff)",
            color: "#080a11",
            fontSize: 34,
            fontWeight: 800,
          }}
        >
          a
        </div>
        <div style={{ display: "flex", fontSize: 30, color: "#9aa3b8" }}>
          aipm · suggest-only work bot
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            fontSize: 84,
            fontWeight: 800,
            color: "#e7eaf3",
            letterSpacing: "-2px",
          }}
        >
          it drafts the nudge.
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 84,
            fontWeight: 800,
            letterSpacing: "-2px",
            color: "#8aa0ff",
          }}
        >
          you approve with one reaction.
        </div>
      </div>

      <div style={{ display: "flex", gap: 14 }}>
        {TAGS.map((tag) => (
          <div
            key={tag}
            style={{
              display: "flex",
              fontSize: 24,
              color: "#9aa3b8",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 999,
              padding: "8px 20px",
            }}
          >
            {tag}
          </div>
        ))}
      </div>
    </div>,
    size,
  );
};

export { alt, size, contentType };
export default Image;
