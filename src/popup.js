document.getElementById("startBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const status = document.getElementById("status");

  status.textContent = "Activating...";

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content.js"],
  }).catch(() => {});

  chrome.tabs.sendMessage(tab.id, { type: "ACTIVATE" }, () => {
    status.textContent = "Running on this page ✓";
    setTimeout(() => window.close(), 800);
  });
});

document.getElementById("settingsLink").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
