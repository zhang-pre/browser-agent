// Firefox Reverse ships en-US and zh-CN resources. Keep these as defaults so
// users can still select another installed UI language in Firefox settings.
pref("extensions.browser-agent.version", "0.24.1");
// Page exceptions remain in DevTools without flooding the launch terminal.
pref("browser.dom.window.dump.enabled", false);
pref("intl.locale.requested", "zh-CN");
pref("intl.accept_languages", "zh-CN, zh, en-US, en");
