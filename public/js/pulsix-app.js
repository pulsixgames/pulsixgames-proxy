import { TabManager } from "./tabs.js";

const $ = selector => document.querySelector(selector);

const address = $("#addr");
const homeInput = $("#home-in");
const tabBar = $("#tabs");
const view = $("#view");

const manager = new TabManager(view);
const tabElements = new Map();

const SEARCH = "https://html.duckduckgo.com/html/?q=";

function toUrl(text) {
    text = text.trim();

    if (!text) return "";

    if (/^https?:\/\//i.test(text)) return text;

    if (
        !/\s/.test(text) &&
        /^[\w-]+(\.[\w-]+)+(:\d+)?([\/?#].*)?$/.test(text)
    ) {
        return "https://" + text;
    }

    return SEARCH + encodeURIComponent(text);
}

function createTabElement(tab) {
    const element = document.createElement("div");

    element.className = "tab enter";
    element.dataset.id = tab.id;

    element.innerHTML = `
        <span class="ico">🌐</span>
        <span class="ttl"></span>
        <button class="x" aria-label="Close tab">×</button>
    `;

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            element.classList.remove("enter");
        });
    });

    return element;
}

function renderTabs() {
    const existing = new Set(manager.tabs.map(tab => tab.id));

    for (const [id, element] of tabElements) {
        if (!existing.has(id)) {
            element.remove();
            tabElements.delete(id);
        }
    }

    for (const tab of manager.tabs) {
        let element = tabElements.get(tab.id);

        if (!element) {
            element = createTabElement(tab);
            tabElements.set(tab.id, element);
        }

        element.classList.toggle("on", tab === manager.active);
        element.classList.toggle("loading", tab.loading);

        element.querySelector(".ttl").textContent = tab.title;

        tabBar.append(element);
    }

    const selected = tabBar.querySelector(".tab.on");

    if (selected) {
        selected.scrollIntoView({
            inline: "nearest",
            block: "nearest"
        });
    }

    updateToolbar();
}

function updateToolbar() {
    const tab = manager.active;

    if (!tab) return;

    if (document.activeElement !== address) {
        address.value = tab.url;
    }

    $("#bk").disabled = !tab.canGoBack;
    $("#fw").disabled = !tab.canGoForward;

    view.classList.toggle("busy", tab.loading);

    $("#rl").classList.toggle("loading", tab.loading);

    $("#home").classList.toggle("show", !tab.url);

    $("#retry").classList.toggle("show", !!tab.error);

    $("#retry-msg").textContent = tab.error || "";
}

manager.onChange(renderTabs);

function navigate(text) {
    const url = toUrl(text);

    if (!url) return;

    let tab = manager.active;

    if (!tab) {
        tab = manager.open();
    }

    void tab.go(url);
}

function newTab() {
    manager.open();
    homeInput.value = "";
    homeInput.focus();
}

function closeActiveTab() {
    if (manager.active) {
        manager.close(manager.active.id);
    }
}

function goBack() {
    const tab = manager.active;

    if (!tab) return;

    const url = tab.back();

    if (url) void tab.go(url);
}

function goForward() {
    const tab = manager.active;

    if (!tab) return;

    const url = tab.forward();

    if (url) void tab.go(url);
}

function reload() {
    const button = $("#rl");

    button.classList.remove("spin");
    void button.offsetWidth;
    button.classList.add("spin");

    manager.active?.reload();
}

// Tab selection and closing
tabBar.addEventListener("click", event => {
    const element = event.target.closest(".tab");

    if (!element) return;

    if (event.target.closest(".x")) {
        manager.close(element.dataset.id);
    } else {
        manager.select(element.dataset.id);
    }
});

tabBar.addEventListener("auxclick", event => {
    const element = event.target.closest(".tab");

    if (element && event.button === 1) {
        event.preventDefault();
        manager.close(element.dataset.id);
    }
});

// Browser controls
$("#newtab").addEventListener("click", newTab);
$("#bk").addEventListener("click", goBack);
$("#fw").addEventListener("click", goForward);
$("#rl").addEventListener("click", reload);

$("#go").addEventListener("click", () => {
    navigate(address.value);
});

address.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        navigate(address.value);
    }
});

homeInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        navigate(homeInput.value);
        homeInput.value = "";
    }
});

$("#retry-btn").addEventListener("click", reload);

// Quick links
document.querySelectorAll("[data-go]").forEach(button => {
    button.addEventListener("click", () => {
        navigate(button.dataset.go);
    });
});

// Back to games
$("#back").addEventListener("click", () => {
    try {
        if (parent !== window) {
            parent.document.getElementById("homeBtn").click();
            return;
        }
    } catch {}

    location.href = "./site.html";
});

// Keyboard shortcuts
function cycleTabs(direction) {
    if (manager.tabs.length < 2) return;

    const index = manager.tabs.indexOf(manager.active);

    const next =
        (index + direction + manager.tabs.length) %
        manager.tabs.length;

    manager.select(manager.tabs[next].id);
}

function shortcut(key, shift, alt) {
    const k = key.toLowerCase();

    if (k === "t") newTab();
    else if (k === "w") closeActiveTab();
    else if (k === "l" && !alt) {
        address.focus();
        address.select();
    }
    else if (k === "r" && !alt) reload();
    else if (k === "tab" && !alt) {
        cycleTabs(shift ? -1 : 1);
    }
    else if (alt && k === "arrowright") cycleTabs(1);
    else if (alt && k === "arrowleft") cycleTabs(-1);
    else return false;

    return true;
}

document.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey || event.altKey)) return;

    if (shortcut(event.key, event.shiftKey, event.altKey)) {
        event.preventDefault();
    }
});

// Status
$("#status").textContent = "Proxy ready";
$("#status-dot").className = "dot green";

// Start with one empty tab
manager.open();
