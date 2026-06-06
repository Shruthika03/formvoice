// ─── ENTRY POINT ─────────────────────────────────────────────────────────────
(function () {
  if (window.__formVoiceInjected) return;
  window.__formVoiceInjected = true;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "ACTIVATE") startFormAssistant();
  });
})();

// ─── MAIN ORCHESTRATOR ───────────────────────────────────────────────────────
async function startFormAssistant() {
  showOverlay("Scanning form fields...");

  const fields = detectFormFields();
  if (!fields.length) {
    await speakAndWait("No form fields found on this page.");
    hideOverlay();
    return;
  }

  await speakAndWait(`Found ${fields.length} fields. Fetching your profile and memories.`);
  updateOverlay("Loading your profile...");

  const [omiResult, qdrantResult] = await Promise.all([
    sendBg("FETCH_OMI_MEMORIES"),
    sendBg("FETCH_QDRANT_PROFILE"),
  ]);

  const profile = {
    ...(qdrantResult.profile || {}),
    omiMemories: omiResult.memoryText || "",
  };

  updateOverlay("Agent deciding how to fill fields...");

  const { decisions } = await sendBg("LYZR_DECIDE", {
    fields: fields.map((f) => ({ fieldId: f.id, label: f.label, type: f.type })),
    profile,
  });

  const filledData = {};

  for (const decision of (decisions || [])) {
    const field = fields.find((f) => f.id === decision.fieldId);
    if (!field) continue;

    if (decision.action === "autofill" && decision.value) {
      const filled = fillField(field.element, decision.value);
      if (filled) {
        filledData[field.label] = decision.value;
        updateOverlay(`Auto-filled: ${field.label}`);
        await speakAndWait(`${field.label} filled with ${decision.value}.`);
        continue;
      }
    }
    // Ask user via voice
    const value = await askUserVoice(field);
    if (value) filledData[field.label] = value;
  }

  // If no decisions returned, fall back to all voice
  if (!decisions || decisions.length === 0) {
    await handleAllVoice(fields, filledData);
    return;
  }

  const updatedProfile = { ...profile };
  for (const [label, value] of Object.entries(filledData)) {
    updatedProfile[label.toLowerCase().replace(/\s+/g, "_")] = value;
  }
  delete updatedProfile.omiMemories;
  sendBg("SAVE_QDRANT_PROFILE", { data: updatedProfile });

  await confirmationReadback(filledData);
}

// ─── FORM FIELD DETECTION ────────────────────────────────────────────────────
function detectFormFields() {
  const inputs = document.querySelectorAll(
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=checkbox]):not([type=radio]), select, textarea"
  );
  const fields = [];
  inputs.forEach((el, i) => {
    const label = getFieldLabel(el) || `Field ${i + 1}`;
    const id = el.id || el.name || `field-${i}`;
    const type = el.type || el.tagName.toLowerCase();
    fields.push({ id, label, element: el, type });
  });
  return fields;
}

function getFieldLabel(el) {
  let text = null;
  if (el.id) {
    const lbl = document.querySelector(`label[for="${el.id}"]`);
    if (lbl) text = lbl.innerText.trim();
  }
  if (!text && el.getAttribute("aria-label")) text = el.getAttribute("aria-label");
  if (!text && el.placeholder) text = el.placeholder;
  if (!text) {
    const parent = el.closest("label");
    if (parent) text = parent.innerText.replace(el.value, "").trim();
  }
  // Strip asterisks, bullets, extra whitespace
  return text ? text.replace(/[*✱＊•·]/g, "").replace(/\s+/g, " ").trim() : null;
}

// ─── FILL FIELD ───────────────────────────────────────────────────────────────
function fillField(el, value) {
  try {
    const type = (el.type || "").toLowerCase();
    const tag = el.tagName.toLowerCase();
    let success = false;

    if (tag === "select") {
      success = fillSelect(el, value);
    } else if (type === "date") {
      success = fillDate(el, value);
    } else {
      el.value = value;
      success = true;
    }

    if (success) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.classList.add("fva-filled");
    }
    return success;
  } catch (e) {
    return false;
  }
}

function fillSelect(el, value) {
  const options = Array.from(el.options);
  const lower = value.toLowerCase().trim();
  const match =
    options.find((o) => o.value.toLowerCase() === lower) ||
    options.find((o) => o.text.toLowerCase() === lower) ||
    options.find((o) => o.text.toLowerCase().includes(lower)) ||
    options.find((o) => lower.includes(o.text.toLowerCase()) && o.value !== "");
  if (match) {
    el.value = match.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.classList.add("fva-filled");
    return true;
  }
  return false;
}

function fillDate(el, value) {
  let date = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date = value;
  } else {
    const parsed = new Date(value);
    if (!isNaN(parsed)) {
      const y = parsed.getFullYear();
      const m = String(parsed.getMonth() + 1).padStart(2, "0");
      const d = String(parsed.getDate()).padStart(2, "0");
      date = `${y}-${m}-${d}`;
    }
  }
  if (date) {
    el.value = date;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.classList.add("fva-filled");
    return true;
  }
  return false;
}

// ─── VOICE CAPTURE WITH CONFIRMATION ─────────────────────────────────────────
function captureVoice(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { resolve(""); return; }

    const recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 3; // get top 3 alternatives for better accuracy
    recognition.continuous = false;

    const timer = setTimeout(() => { try { recognition.stop(); } catch(e){} resolve(""); }, timeoutMs);

    recognition.onresult = (e) => {
      clearTimeout(timer);
      // Pick the highest confidence alternative
      const results = Array.from(e.results[0]);
      const best = results.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      resolve(best.transcript.trim());
    };
    recognition.onerror = (e) => { clearTimeout(timer); resolve(""); };
    recognition.start();
  });
}

// Ask user for a field value with spell-out confirmation for names
async function askUserVoice(field) {
  const { label, element, type } = field;
  const inputType = (element.type || "").toLowerCase();

  // Tailored prompts per field type
  let prompt = `Please say your ${label}.`;
  if (inputType === "date") prompt = `Please say your ${label}. For example: May 15, 1990.`;
  if (inputType === "email") prompt = `Please spell out your ${label}. For example: j o h n at gmail dot com.`;
  if (inputType === "tel") prompt = `Please say your ${label}, digit by digit.`;
  if (label.toLowerCase().includes("name")) prompt = `Please say your ${label} clearly.`;

  await speakAndWait(prompt);
  updateOverlay(`🎙️ Listening for: ${label}`);

  let value = await captureVoice(10000);
  if (!value) return "";

  // For name fields: confirm spelling to avoid errors
  if (label.toLowerCase().includes("name")) {
    value = capitalizeWords(value);
    await speakAndWait(`I heard: ${spellOut(value)}. Is that correct? Say yes or no.`);
    updateOverlay("🎙️ Say YES or NO...");
    const confirm = await captureVoice(6000);
    if (confirm.toLowerCase().includes("no")) {
      await speakAndWait(`Let's try again. Please say your ${label} slowly.`);
      updateOverlay(`🎙️ Listening again for: ${label}`);
      value = await captureVoice(10000);
      if (!value) return "";
      value = capitalizeWords(value);
    }
  }

  // For email: normalize spoken email
  if (inputType === "email") {
    value = normalizeEmail(value);
  }

  const filled = fillField(element, value);
  if (filled) {
    await speakAndWait(`Got it.`);
    return value;
  } else {
    await speakAndWait(`Could not fill ${label}. Please fill it manually.`);
    return "";
  }
}

// ─── TEXT HELPERS ─────────────────────────────────────────────────────────────
function capitalizeWords(str) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

function spellOut(str) {
  // "John" → "J - O - H - N" for confirmation
  return str.split("").join(" - ");
}

function normalizeEmail(spoken) {
  return spoken
    .toLowerCase()
    .replace(/\s+at\s+/g, "@")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9@._+-]/g, "");
}

// ─── FALLBACK: All fields by voice ───────────────────────────────────────────
async function handleAllVoice(fields, filledData = {}) {
  for (const field of fields) {
    const value = await askUserVoice(field);
    if (value) filledData[field.label] = value;
  }
  await confirmationReadback(filledData);
}

// ─── CONFIRMATION READBACK ───────────────────────────────────────────────────
async function confirmationReadback(filledData) {
  updateOverlay("Reading back your entries...");

  let summary = "Here is what will be submitted. ";
  for (const [label, value] of Object.entries(filledData)) {
    summary += `${label}: ${value}. `;
  }
  summary += "Say YES to confirm and submit, or NO to cancel.";

  await speakAndWait(summary);
  updateOverlay("🎙️ Say YES to submit or NO to cancel...");

  const confirmation = await captureVoice(8000);
  if (confirmation.toLowerCase().includes("yes")) {
    submitForm();
    await speakAndWait("Form submitted successfully. Thank you.");
    showOverlay("✅ Submitted!");
    setTimeout(hideOverlay, 3000);
  } else {
    await speakAndWait("Submission cancelled. You can review and try again.");
    hideOverlay();
  }
}

function submitForm() {
  const form = document.querySelector("form");
  if (form) {
    const btn = form.querySelector("[type=submit]");
    if (btn) btn.click(); else form.submit();
  }
}

// ─── TEXT TO SPEECH ───────────────────────────────────────────────────────────
function speakAndWait(text) {
  return new Promise((resolve) => {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.9;
    utter.pitch = 1;
    utter.onend = resolve;
    utter.onerror = resolve;
    window.speechSynthesis.speak(utter);
  });
}

// ─── OVERLAY ─────────────────────────────────────────────────────────────────
function showOverlay(msg) {
  let el = document.getElementById("fva-overlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "fva-overlay";
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="fva-icon">🎙️</div><div class="fva-msg">${msg}</div><div class="fva-spinner"></div>`;
  el.classList.add("fva-visible");
}

function updateOverlay(msg) {
  const el = document.querySelector("#fva-overlay .fva-msg");
  if (el) el.textContent = msg;
}

function hideOverlay() {
  const el = document.getElementById("fva-overlay");
  if (el) el.classList.remove("fva-visible");
}

// ─── BG MESSENGER ────────────────────────────────────────────────────────────
function sendBg(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => resolve(res || {}));
  });
}
