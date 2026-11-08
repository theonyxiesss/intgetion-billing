import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PHONE_WALLET_INNER_CSS,
  PHONE_WALLET_MODAL_CSS,
  connectWallet,
  findBrowserWallet,
  walletModalOptions,
} from "./connect-wallet";

const { init, connect } = vi.hoisted(() => ({
  init: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("@walletconnect/ethereum-provider", () => ({
  EthereumProvider: {
    init: (...args: unknown[]) => init(...args),
  },
}));

type Request = (args: { method: string }) => Promise<unknown>;

/** A browser window where each EIP-6963 wallet answers the request event. */
function browser({
  announced = [],
  ethereum,
  phone = false,
  userAgent = "",
}: {
  announced?: { rdns: string; request: Request }[];
  ethereum?: { request: Request };
  phone?: boolean;
  userAgent?: string;
}) {
  const target = new EventTarget();
  target.addEventListener("eip6963:requestProvider", () => {
    for (const wallet of announced) {
      target.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: {
            info: { rdns: wallet.rdns, name: wallet.rdns, uuid: wallet.rdns },
            provider: { request: wallet.request },
          },
        }),
      );
    }
  });
  vi.stubGlobal(
    "window",
    Object.assign(target, {
      ethereum,
      location: { origin: "https://intgetion.com" },
      navigator: { userAgent },
      matchMedia: (query: string) => ({
        matches: phone && query === "(max-width: 767px)",
        addEventListener() {},
        removeEventListener() {},
      }),
    }),
  );
}

function qrOptions() {
  return walletModalOptions({
    mode: "dark",
    accent: "#0057ff",
    background: "#000000",
  });
}

describe("wallet window", () => {
  it("matches the page and sits above the phone chrome", () => {
    expect(qrOptions()).toEqual({
      enableMobileFullScreen: true,
      themeMode: "dark",
      themeVariables: {
        "--wcm-z-index": "200",
        "--wcm-accent-color": "#0057ff",
        "--wcm-background-color": "#000000",
        "--wcm-font-family": "Geist, ui-sans-serif, system-ui, sans-serif",
        "--wcm-container-border-radius": "0px",
      },
    });
  });

  it("fills the phone and keeps the search field on its own row", () => {
    expect(PHONE_WALLET_MODAL_CSS).toContain("backdrop-filter: none");
    expect(PHONE_WALLET_MODAL_CSS).toContain("100dvh");
    expect(PHONE_WALLET_INNER_CSS).toContain("wui-search-bar");
    expect(PHONE_WALLET_INNER_CSS).toContain("min-width: 0");
    expect(PHONE_WALLET_INNER_CSS).toContain("flex: 1 1 100%");
  });
});

function qrProvider() {
  const provider = { connect, request: vi.fn() };
  init.mockResolvedValue(provider);
  connect.mockResolvedValue(undefined);
  return provider;
}

describe("findBrowserWallet", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers MetaMask among EIP-6963 wallets (D422)", async () => {
    const other = vi.fn(async () => []);
    const metamask = vi.fn(async () => []);
    browser({
      announced: [
        { rdns: "app.phantom", request: other },
        { rdns: "io.metamask", request: metamask },
      ],
    });

    const wallet = await findBrowserWallet(0);

    expect(wallet?.request).toBe(metamask);
  });

  it("falls back to window.ethereum, then to nothing", async () => {
    const request = vi.fn(async () => []);
    browser({ ethereum: { request } });
    expect(await findBrowserWallet(0)).toEqual({ request });

    browser({});
    expect(await findBrowserWallet(0)).toBeNull();
  });
});

describe("connectWallet", () => {
  afterEach(() => {
    init.mockReset();
    connect.mockReset();
    vi.unstubAllGlobals();
  });

  it("uses the injected wallet when the project id is empty", async () => {
    const request = vi.fn(async () => ["0xabc"]);
    browser({ ethereum: { request } });

    const wallet = await connectWallet("");

    expect(init).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
    expect(wallet).toEqual({ request });
  });

  it("throws when the project id is empty and no wallet is installed", async () => {
    browser({});

    await expect(connectWallet("", "qr")).rejects.toThrow("wallet");
    expect(init).not.toHaveBeenCalled();
  });

  it("opens MetaMask, not the QR, when the extension is installed (D422)", async () => {
    const request = vi.fn(async () => ["0xabc"]);
    browser({ announced: [{ rdns: "io.metamask", request }] });

    const wallet = await connectWallet("project-id");

    expect(init).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
    expect(wallet.request).toBe(request);
  });

  it("opens the WalletConnect QR modal when no extension is installed", async () => {
    const provider = qrProvider();
    browser({});

    const wallet = await connectWallet("project-id");

    expect(init).toHaveBeenCalledWith({
      projectId: "project-id",
      chains: [1],
      optionalChains: [137, 42161, 8453],
      showQrModal: true,
      qrModalOptions: qrOptions(),
      metadata: {
        name: "INTGETION JOB LIST",
        description: "Pay for a plan",
        url: "https://intgetion.com",
        icons: ["https://intgetion.com/icon.png"],
      },
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(wallet).toBe(provider);
  });

  it("opens the WalletConnect window on the phone layout even when MetaMask is installed (D425)", async () => {
    const provider = qrProvider();
    const request = vi.fn(async () => ["0xabc"]);
    browser({
      phone: true,
      announced: [{ rdns: "io.metamask", request }],
    });

    const wallet = await connectWallet("project-id");

    expect(request).not.toHaveBeenCalled();
    expect(init).toHaveBeenCalledOnce();
    expect(wallet).toBe(provider);
  });

  it("keeps the in-app wallet when the phone browser is the wallet itself", async () => {
    const request = vi.fn(async () => ["0xabc"]);
    browser({
      phone: true,
      userAgent: "Mozilla/5.0 MetaMaskMobile",
      announced: [{ rdns: "io.metamask", request }],
    });

    const wallet = await connectWallet("project-id");

    expect(init).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
    expect(wallet.request).toBe(request);
  });

  it("opens the QR when the user picks a mobile wallet", async () => {
    const provider = qrProvider();
    const request = vi.fn(async () => ["0xabc"]);
    browser({ announced: [{ rdns: "io.metamask", request }] });

    const wallet = await connectWallet("project-id", "qr");

    expect(request).not.toHaveBeenCalled();
    expect(wallet).toBe(provider);
  });
});
