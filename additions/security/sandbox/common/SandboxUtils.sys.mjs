/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

export var SandboxUtils = {
  _sandboxDisabledThisSession: false,
  /**
   * Show a notification bar if user is running without unprivileged namespace
   *
   * @param {Window} aWindow
   *        The window where the notification will be displayed.
   */
  maybeWarnAboutMissingUserNamespaces:
    function SU_maybeWarnAboutMissingUserNamespaces(aWindow) {
      if (AppConstants.platform !== "linux") {
        return;
      }

      // This would cover Flatpak, Snap or any "Packaged App" (e.g., Debian package)
      // Showing the notification on Flatpak would not be correct because of
      // existing Flatpak isolation (see Bug 1882881). And for Snap and
      // Debian packages it would be irrelevant as well.
      const isPackagedApp = Services.sysinfo.getPropertyAsBool("isPackagedApp");
      if (isPackagedApp) {
        return;
      }

      const kSandboxUserNamespacesPref =
        "security.sandbox.warn_unprivileged_namespaces";
      const kSandboxUserNamespacesPrefValue = Services.prefs.getBoolPref(
        kSandboxUserNamespacesPref
      );
      if (!kSandboxUserNamespacesPrefValue) {
        return;
      }

      const userNamespaces =
        Services.sysinfo.getPropertyAsBool("hasUserNamespaces");
      if (userNamespaces) {
        return;
      }

      let box = aWindow.gNotificationBox;
      const mozXulElement = box.stack.documentGlobal.MozXULElement;
      mozXulElement.insertFTLIfNeeded("toolkit/updates/elevation.ftl");

      let buttons = [
        {
          supportPage: "linux-security-warning",
          "l10n-id": "sandbox-unprivileged-namespaces-howtofix",
        },
        {
          "l10n-id": "sandbox-unprivileged-namespaces-dismiss-button",
          callback: () => {
            Services.prefs.setBoolPref(kSandboxUserNamespacesPref, false);
          },
        },
      ];

      // Now actually create the notification
      box.appendNotification(
        "sandbox-unprivileged-namespaces",
        {
          label: { "l10n-id": "sandbox-missing-unprivileged-namespaces" },
          priority: box.PRIORITY_WARNING_HIGH,
        },
        buttons
      );
    },

  maybeWarnAboutDisabledContentSandbox() {
    // This build intentionally suppresses the disabled-content-sandbox notification.
  },

  observeContentSandboxPref() {
    const observer = {
      observe() {
        const level = Services.prefs.getIntPref(
          "security.sandbox.content.level",
          -1
        );
        if (level === 0) {
          const winEnum = Services.wm.getEnumerator("navigator:browser");
          while (winEnum.hasMoreElements()) {
            const win = winEnum.getNext();
            SandboxUtils.maybeWarnAboutDisabledContentSandbox(win);
          }
          Services.prefs.removeObserver(
            "security.sandbox.content.level",
            observer
          );
        }
      },
    };
    Services.prefs.addObserver("security.sandbox.content.level", observer);
  },
};
