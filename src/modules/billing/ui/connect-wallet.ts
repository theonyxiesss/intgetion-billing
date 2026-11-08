type Wallet = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type Announced = { info?: { rdns?: string }; provider?: Wallet };

/** Where the pay button sends the user: the browser extension, or the QR. */
export type WalletRoute = "browser" | "qr";

const PHONE_LAYOUT = "(max-width: 767px)";

export type WalletTheme = {
  mode: "dark" | "light";
  accent: string;
  background: string;
};

/**
 * AppKit colours and stacking. The library maps these `--wcm-*` names onto
 * its own tokens. Radius 0 matches the full-screen phone sheet.
 */
export function walletModalOptions(theme: WalletTheme) {
  return {
    enableMobileFullScreen: true,
    themeMode: theme.mode,
    themeVariables: {
      "--wcm-z-index": "200",
      "--wcm-accent-color": theme.accent,
      "--wcm-background-color": theme.background,
      "--wcm-font-family": "Geist, ui-sans-serif, system-ui, sans-serif",
      "--wcm-container-border-radius": "0px",
    },
  };
}

function readWalletTheme(): WalletTheme {
  const fallback: WalletTheme = {
    mode: "dark",
    accent: "#0057ff",
    background: "#000000",
  };
  if (typeof document === "undefined") return fallback;
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const pick = (name: string, or: string) =>
    style.getPropertyValue(name).trim() || or;
  return {
    mode: root.dataset.theme === "light" ? "light" : "dark",
    accent: pick("--accent", fallback.accent),
    background: pick("--bg", fallback.background),
  };
}

/** The card fills the phone. The library's own blur is what hides the list. */
export const PHONE_WALLET_MODAL_CSS = `
:host {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
wui-card {
  max-width: 100% !important;
  width: 100% !important;
  height: 100dvh !important;
  max-height: 100dvh !important;
  margin: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
wui-flex {
  align-items: stretch !important;
  max-width: 100% !important;
  min-width: 0 !important;
}
`;

/**
 * The search row is the field, a switch and a QR mark in one line. On a
 * phone that line is wider than the sheet, and the field is cut off on the
 * left. The field takes the whole row; the other two drop below it.
 */
export const PHONE_WALLET_INNER_CSS = `
wui-flex {
  flex-wrap: wrap !important;
  max-width: 100% !important;
  min-width: 0 !important;
}
wui-search-bar {
  flex: 1 1 100% !important;
  min-width: 0 !important;
  width: 100% !important;
}
wui-grid {
  width: 100% !important;
  max-width: 100% !important;
  grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr)) !important;
}
`;

const paintedShadows = new WeakSet<ShadowRoot>();
const watchedShadows = new WeakSet<ShadowRoot>();

function paintShadow(shadow: ShadowRoot, css: string) {
  if (paintedShadows.has(shadow)) return;
  paintedShadows.add(shadow);
  const style = document.createElement("style");
  style.dataset.phoneWallet = "";
  style.textContent = css;
  shadow.append(style);
}

function watchWalletTree(modal: Element) {
  const scan = () => {
    const visit = (node: Element) => {
      const shadow = node.shadowRoot;
      if (!shadow) return;
      paintShadow(
        shadow,
        node === modal ? PHONE_WALLET_MODAL_CSS : PHONE_WALLET_INNER_CSS,
      );
      if (
        !watchedShadows.has(shadow) &&
        typeof MutationObserver === "function"
      ) {
        watchedShadows.add(shadow);
        const observer = new MutationObserver(scan);
        observer.observe(shadow, { childList: true, subtree: true });
      }
      for (const child of shadow.querySelectorAll("*")) visit(child);
    };
    visit(modal);
  };
  scan();
}

/** Phone sheet: full screen, no library blur, search field on its own row. */
export function fitPhoneWalletWindow(root: ParentNode = document): void {
  const modal = root.querySelector("w3m-modal");
  if (!(modal instanceof Element)) return;
  watchWalletTree(modal);
}

/**
 * The phone layout of the site. The desktop extension popup does not appear
 * there, so the pay button opens the WalletConnect window instead (D425).
 */
export function phoneLayout(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(PHONE_LAYOUT).matches
  );
}

/**
 * The page is already open inside a wallet app. That app's own provider is
 * the pay window; the QR would only send the person back into the same app.
 */
export function inWalletApp(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator?.userAgent ?? "";
  return /MetaMaskMobile|Trust\/|CoinbaseWallet|Phantom|TokenPocket/i.test(ua);
}

/**
 * Installed browser wallet, found through EIP-6963 announcements. MetaMask
 * wins when several answer; an old wallet that only sets `window.ethereum`
 * still counts (D422).
 */
export function findBrowserWallet(waitMs = 150): Promise<Wallet | null> {
  return new Promise((resolve) => {
    const found: Announced[] = [];
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Announced>).detail;
      if (typeof detail?.provider?.request === "function") found.push(detail);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const pick =
        found.find((item) => item.info?.rdns === "io.metamask") ?? found[0];
      const legacy = (window as Window & { ethereum?: Wallet }).ethereum;
      resolve(
        pick?.provider ??
          (typeof legacy?.request === "function" ? legacy : null),
      );
    }, waitMs);
  });
}

/**
 * The browser wallet comes first on a wide screen (D422). On the phone layout
 * the WalletConnect window comes first: the extension popup does not open
 * there (D425). An in-app wallet browser still uses its own provider. The QR
 * also opens when there is no browser wallet, or when the user picked it.
 * Empty id: browser wallet only (D356). The modal loads `@reown/appkit/core`,
 * so that package stays a direct dependency at the provider's version (D406).
 */
export async function connectWallet(
  projectId: string,
  route: WalletRoute = "browser",
): Promise<Wallet> {
  const id = projectId.trim();
  const walletConnectFirst =
    Boolean(id) && (route === "qr" || (phoneLayout() && !inWalletApp()));
  if (!walletConnectFirst) {
    const injected = await findBrowserWallet();
    if (injected) {
      await injected.request({ method: "eth_requestAccounts" });
      return injected;
    }
    if (!id) throw new Error("wallet");
  }
  const mod = await import("@walletconnect/ethereum-provider");
  const provider = await mod.EthereumProvider.init({
    projectId: id,
    chains: [1],
    optionalChains: [137, 42161, 8453],
    showQrModal: true,
    qrModalOptions: walletModalOptions(readWalletTheme()),
    metadata: {
      name: "INTGETION JOB LIST",
      description: "Pay for a plan",
      url: window.location.origin,
      icons: [`${window.location.origin}/icon.png`],
    },
  });
  if (phoneLayout() && typeof document !== "undefined") fitPhoneWalletWindow();
  await provider.connect();
  return provider;
}
