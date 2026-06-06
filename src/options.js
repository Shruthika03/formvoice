// ── TAB SWITCHING ──────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ── API KEYS ───────────────────────────────────────────────────────────────────
const API_FIELDS = ["qdrantUrl", "qdrantKey", "qdrantCollection", "lyzrKey", "lyzrAgentId", "omiKey"];

chrome.storage.sync.get(API_FIELDS, (data) => {
  API_FIELDS.forEach(key => {
    if (data[key]) document.getElementById(key).value = data[key];
  });
});

document.getElementById('saveApiBtn').addEventListener('click', () => {
  const values = {};
  API_FIELDS.forEach(key => { values[key] = document.getElementById(key).value.trim(); });
  chrome.storage.sync.set(values, () => {
    showStatus('apiSaveStatus', '✓ Saved!', 'ok');
  });
});

// ── PROFILE FIELDS ─────────────────────────────────────────────────────────────
const PROFILE_FIELDS = ['p_name', 'p_dob', 'p_email', 'p_phone', 'p_address', 'p_city', 'p_state', 'p_zip', 'p_country', 'p_gender'];

const FIELD_MAP = {
  p_name: 'name', p_dob: 'date_of_birth', p_email: 'email',
  p_phone: 'phone', p_address: 'address', p_city: 'city',
  p_state: 'state', p_zip: 'zip', p_country: 'country', p_gender: 'gender'
};

function getProfileFromInputs() {
  const profile = {};
  PROFILE_FIELDS.forEach(id => {
    const val = document.getElementById(id).value.trim();
    if (val) profile[FIELD_MAP[id]] = val;
  });
  return profile;
}

function setProfileToInputs(payload) {
  PROFILE_FIELDS.forEach(id => {
    const key = FIELD_MAP[id];
    if (payload[key] !== undefined) {
      document.getElementById(id).value = payload[key];
    }
  });
}

// ── LOAD FROM QDRANT ───────────────────────────────────────────────────────────
document.getElementById('loadProfileBtn').addEventListener('click', async () => {
  setBanner('info', '⏳ Loading your profile from Qdrant...');
  setLoading(true);

  const response = await sendBg('FETCH_QDRANT_PROFILE');

  if (response.error) {
    setBanner('err', '✗ Could not connect to Qdrant. Check your API keys.');
  } else if (!response.profile || Object.keys(response.profile).length === 0) {
    setBanner('err', '⚠ No profile found in Qdrant. Fill in your details and click Save.');
  } else {
    setProfileToInputs(response.profile);
    setBanner('ok', '✓ Profile loaded successfully from Qdrant.');
  }
  setLoading(false);
});

// ── SAVE TO QDRANT ─────────────────────────────────────────────────────────────
document.getElementById('saveProfileBtn').addEventListener('click', async () => {
  const profile = getProfileFromInputs();
  if (Object.keys(profile).length === 0) {
    setBanner('err', '⚠ Please fill in at least one field before saving.');
    return;
  }

  setBanner('info', '⏳ Saving your profile to Qdrant...');
  setLoading(true);

  const response = await sendBg('SAVE_QDRANT_PROFILE', { data: profile });

  if (response.success) {
    setBanner('ok', '✓ Profile saved to Qdrant! FormVoice will use this data to autofill forms.');
  } else {
    setBanner('err', '✗ Save failed. Make sure your Qdrant URL and API key are correct.');
  }
  setLoading(false);
});

// ── HELPERS ────────────────────────────────────────────────────────────────────
function setBanner(type, msg) {
  const el = document.getElementById('profileStatus');
  el.className = type;
  el.textContent = msg;
}

function showStatus(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'status ' + type;
  setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 2500);
}

function setLoading(on) {
  document.getElementById('loadProfileBtn').disabled = on;
  document.getElementById('saveProfileBtn').disabled = on;
}

function sendBg(type, payload = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type, ...payload }, res => resolve(res || {}));
  });
}
