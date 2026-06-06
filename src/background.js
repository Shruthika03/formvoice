// ─── CONFIG ───────────────────────────────────────────────────────────────────
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ["qdrantUrl", "qdrantKey", "qdrantCollection", "lyzrKey", "lyzrAgentId", "omiKey"],
      (data) => resolve({
        QDRANT_URL: data.qdrantUrl || "",
        QDRANT_API_KEY: data.qdrantKey || "",
        QDRANT_COLLECTION: data.qdrantCollection || "user_profile",
        LYZR_API_KEY: data.lyzrKey || "",
        LYZR_AGENT_ID: data.lyzrAgentId || "",
        OMI_API_KEY: data.omiKey || "",
      })
    );
  });
}

// ─── FETCH WITH TIMEOUT ───────────────────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─── MESSAGE ROUTER ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const config = await getConfig();
      switch (msg.type) {
        case "FETCH_OMI_MEMORIES":
          sendResponse(await fetchOmiMemories(config));
          break;
        case "FETCH_QDRANT_PROFILE":
          sendResponse(await fetchQdrantProfile(config));
          break;
        case "LYZR_DECIDE":
          sendResponse(await askLyzr(config, msg.fields, msg.profile));
          break;
        case "SAVE_QDRANT_PROFILE":
          sendResponse(await saveQdrantProfile(config, msg.data));
          break;
        case "GET_CONFIG":
          sendResponse({ config });
          break;
        default:
          sendResponse({ error: "Unknown message type" });
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
  })();
  return true;
});

// ─── OMI: Fetch memories (6s timeout, graceful fallback) ─────────────────────
async function fetchOmiMemories(config) {
  try {
    const res = await fetchWithTimeout(
      "https://api.omi.me/v1/dev/user/memories?limit=20&categories=personal,work",
      {
        headers: {
          "Authorization": `Bearer ${config.OMI_API_KEY}`,
          "Content-Type": "application/json",
        },
      },
      6000 // 6 second timeout
    );

    if (!res.ok) return { memoryText: "", raw: [] };

    const data = await res.json();
    const memories = Array.isArray(data) ? data : (data.memories || []);

    // Only use structured_data or content fields, skip huge raw JSON
    const memoryText = memories
      .slice(0, 10) // cap at 10 memories to keep prompt short
      .map((m) => {
        if (m.structured_data) return JSON.stringify(m.structured_data);
        return m.content || m.text || "";
      })
      .filter(Boolean)
      .join("\n");

    return { memoryText, raw: memories };
  } catch (err) {
    // Timeout or network error — return empty gracefully
    console.warn("Omi fetch failed or timed out:", err.message);
    return { memoryText: "", raw: [] };
  }
}

// ─── QDRANT: Fetch profile (5s timeout) ──────────────────────────────────────
async function fetchQdrantProfile(config) {
  try {
    const res = await fetchWithTimeout(
      `${config.QDRANT_URL}/collections/${config.QDRANT_COLLECTION}/points/scroll`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": config.QDRANT_API_KEY,
        },
        body: JSON.stringify({ limit: 1, with_payload: true }),
      },
      5000
    );

    if (!res.ok) return { profile: {} };
    const data = await res.json();
    const points = data.result?.points || [];
    return { profile: points[0]?.payload || {} };
  } catch (err) {
    console.warn("Qdrant fetch failed:", err.message);
    return { profile: {} };
  }
}

// ─── QDRANT: Save profile ─────────────────────────────────────────────────────
async function saveQdrantProfile(config, profileData) {
  try {
    await fetchWithTimeout(
      `${config.QDRANT_URL}/collections/${config.QDRANT_COLLECTION}/points`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "api-key": config.QDRANT_API_KEY,
        },
        body: JSON.stringify({
          points: [{ id: 1, vector: new Array(128).fill(0.1), payload: profileData }],
        }),
      },
      5000
    );
    return { success: true };
  } catch (err) {
    return { success: false };
  }
}

// ─── LYZR: Decide autofill vs ask (10s timeout) ───────────────────────────────
async function askLyzr(config, fields, profile) {
  // Keep prompt short — only pass non-empty profile keys and trimmed memories
  const cleanProfile = Object.fromEntries(
    Object.entries(profile).filter(([_, v]) => v && typeof v === "string" && v.length < 200)
  );

  const prompt = `You help fill web forms for visually impaired users.

Profile: ${JSON.stringify(cleanProfile)}

Fields: ${JSON.stringify(fields.map(f => ({ fieldId: f.fieldId, label: f.label })))}

For each field, if you can confidently match a value from the profile, return action "autofill" with the value.
Otherwise return action "ask_user".

Reply ONLY with a JSON array, no markdown, no explanation:
[{"fieldId":"...","label":"...","action":"autofill","value":"..."},{"fieldId":"...","label":"...","action":"ask_user"}]`;

  try {
    const res = await fetchWithTimeout(
      "https://api.lyzr.ai/v2/inference/chat/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.LYZR_API_KEY,
        },
        body: JSON.stringify({
          user_id: "form-assistant-user",
          agent_id: config.LYZR_AGENT_ID,
          message: prompt,
          session_id: "form-session-" + Date.now(),
        }),
      },
      10000 // 10s for Lyzr
    );

    if (!res.ok) throw new Error(`Lyzr ${res.status}`);

    const data = await res.json();
    const text = data.response || data.message || "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON in Lyzr response");
    return { decisions: JSON.parse(jsonMatch[0]) };
  } catch (err) {
    console.warn("Lyzr failed:", err.message);
    // Fallback: mark all fields as ask_user so the flow still works
    return {
      decisions: fields.map((f) => ({
        fieldId: f.fieldId,
        label: f.label,
        action: "ask_user",
      })),
    };
  }
}
