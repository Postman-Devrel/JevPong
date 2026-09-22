const fieldDots = Array.from({ length: 9 }, (_, index) => index);

export const SOCIAL_IMAGE_ALT =
  "Jev Pong — play Pong against Jev, watch every decision, and compete on the global leaderboard";

export const SOCIAL_IMAGE_SIZE = {
  width: 1200,
  height: 630,
} as const;

export function SocialCard() {
  return (
    <div
      style={{
        alignItems: "stretch",
        background:
          "radial-gradient(circle at 12% 0%, rgba(196, 244, 110, 0.13), transparent 34%), #0d100d",
        color: "#f2f4ed",
        display: "flex",
        fontFamily: "Space Grotesk",
        height: "100%",
        padding: "52px 56px",
        position: "relative",
        width: "100%",
      }}
    >
      <div
        style={{
          border: "1px solid #34402c",
          borderRadius: 28,
          display: "flex",
          inset: 24,
          position: "absolute",
        }}
      />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "8px 20px 8px 8px",
          width: "58%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            fontSize: 34,
            fontWeight: 600,
            letterSpacing: "-1px",
          }}
        >
          <div
            style={{
              background: "#c4f46e",
              display: "flex",
              height: 35,
              marginRight: 11,
              width: 8,
            }}
          />
          <div
            style={{
              background: "#ff8a4c",
              display: "flex",
              height: 12,
              marginRight: 11,
              width: 12,
            }}
          />
          <span>jev</span>
          <span style={{ color: "#788172", fontWeight: 400 }}>pong</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              color: "#c4f46e",
              display: "flex",
              fontFamily: "IBM Plex Mono",
              fontSize: 17,
              fontWeight: 600,
              letterSpacing: "2px",
              marginBottom: 17,
              textTransform: "uppercase",
            }}
          >
            Human vs. machine
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 67,
              fontWeight: 600,
              letterSpacing: "-3.8px",
              lineHeight: 0.98,
            }}
          >
            <span>Can you beat</span>
            <span style={{ color: "#c4f46e" }}>Jev?</span>
          </div>
          <div
            style={{
              color: "#a2aa9b",
              display: "flex",
              fontSize: 24,
              lineHeight: 1.35,
              marginTop: 24,
              maxWidth: 560,
            }}
          >
            Play Pong against an AI agent. Watch every decision. Climb the
            global leaderboard.
          </div>
        </div>

        <div
          style={{
            alignItems: "center",
            display: "flex",
            fontFamily: "IBM Plex Mono",
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: "1.2px",
            textTransform: "uppercase",
          }}
        >
          <span style={{ color: "#c4f46e" }}>Play</span>
          <span style={{ color: "#4f5949", margin: "0 14px" }}>/</span>
          <span>Watch</span>
          <span style={{ color: "#4f5949", margin: "0 14px" }}>/</span>
          <span>Compete</span>
        </div>
      </div>

      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "flex-end",
          padding: "8px 8px 8px 20px",
          width: "42%",
        }}
      >
        <div
          style={{
            background: "#11150f",
            border: "1px solid #394532",
            borderRadius: 22,
            display: "flex",
            flexDirection: "column",
            height: 480,
            overflow: "hidden",
            padding: "24px 26px",
            position: "relative",
            width: 420,
          }}
        >
          <div
            style={{
              alignItems: "center",
              display: "flex",
              fontFamily: "IBM Plex Mono",
              fontSize: 13,
              fontWeight: 600,
              justifyContent: "space-between",
              letterSpacing: "1.5px",
              textTransform: "uppercase",
            }}
          >
            <span style={{ color: "#929b8b" }}>Match point</span>
            <span style={{ color: "#c4f46e" }}>Hard</span>
          </div>

          <div
            style={{
              alignItems: "center",
              display: "flex",
              fontFamily: "IBM Plex Mono",
              fontSize: 69,
              fontWeight: 600,
              justifyContent: "center",
              letterSpacing: "-5px",
              marginTop: 20,
            }}
          >
            <span>06</span>
            <span style={{ color: "#4a5445", fontSize: 28, margin: "0 18px" }}>
              —
            </span>
            <span style={{ color: "#c4f46e" }}>06</span>
          </div>

          <div
            style={{
              borderBottom: "1px solid #273021",
              display: "flex",
              marginTop: 14,
              width: "100%",
            }}
          />

          <div
            style={{
              display: "flex",
              flex: 1,
              marginTop: 20,
              position: "relative",
              width: "100%",
            }}
          >
            <div
              style={{
                background: "#eef1e9",
                borderRadius: 4,
                display: "flex",
                height: 82,
                left: 9,
                position: "absolute",
                top: 110,
                width: 10,
              }}
            />
            <div
              style={{
                alignItems: "center",
                display: "flex",
                flexDirection: "column",
                gap: 13,
                left: "50%",
                position: "absolute",
                top: 4,
                transform: "translateX(-50%)",
              }}
            >
              {fieldDots.map((dot) => (
                <div
                  key={dot}
                  style={{
                    background: "#313a2c",
                    borderRadius: 3,
                    display: "flex",
                    height: 6,
                    width: 6,
                  }}
                />
              ))}
            </div>
            <div
              style={{
                background: "#ff8a4c",
                borderRadius: 999,
                boxShadow: "0 0 24px rgba(255, 138, 76, 0.42)",
                display: "flex",
                height: 17,
                left: 136,
                position: "absolute",
                top: 137,
                width: 17,
              }}
            />
            <div
              style={{
                background: "rgba(255, 138, 76, 0.3)",
                borderRadius: 999,
                display: "flex",
                height: 9,
                left: 116,
                position: "absolute",
                top: 141,
                width: 9,
              }}
            />
            <div
              style={{
                background: "#c4f46e",
                borderRadius: 4,
                boxShadow: "0 0 22px rgba(196, 244, 110, 0.2)",
                display: "flex",
                height: 82,
                position: "absolute",
                right: 9,
                top: 79,
                width: 10,
              }}
            />
          </div>

          <div
            style={{
              alignItems: "center",
              borderTop: "1px solid #273021",
              display: "flex",
              fontFamily: "IBM Plex Mono",
              fontSize: 12,
              justifyContent: "space-between",
              letterSpacing: "1px",
              paddingTop: 15,
              textTransform: "uppercase",
            }}
          >
            <span style={{ color: "#929b8b" }}>Player</span>
            <span style={{ color: "#c4f46e" }}>Jev is thinking…</span>
          </div>
        </div>
      </div>
    </div>
  );
}
