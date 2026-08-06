interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredInstall: BeforeInstallPromptEvent | null = null;

export function isMobileUa(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function isIos(): boolean {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Listen for Chromium install prompt; call `onReady` when the button may be shown. */
export function watchInstallPrompt(onReady: () => void): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e as BeforeInstallPromptEvent;
    onReady();
  });
}

export function canShowInstallButton(): boolean {
  if (isStandalone()) return false;
  if (deferredInstall) return true;
  return isMobileUa() && isIos();
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "ios-help" | "unavailable"> {
  if (deferredInstall) {
    await deferredInstall.prompt();
    const { outcome } = await deferredInstall.userChoice;
    deferredInstall = null;
    return outcome;
  }
  if (isIos() && !isStandalone()) return "ios-help";
  return "unavailable";
}
