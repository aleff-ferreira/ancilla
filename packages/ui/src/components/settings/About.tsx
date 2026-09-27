import { ArrowSquareOutIcon } from "../ui/icons.js";

const REPO = "https://github.com/aleff-ferreira/ancilla";

/** The license and notices every copy of Ancilla carries, as published with its source. */
export const LEGAL_LINKS: readonly { label: string; href: string }[] = [
  { label: "License", href: `${REPO}/blob/main/LICENSE` },
  { label: "Helicon's license", href: `${REPO}/blob/main/LICENSE-HELICON` },
  { label: "Notice", href: `${REPO}/blob/main/NOTICE.md` },
  { label: "Third-party notices", href: `${REPO}/blob/main/THIRD_PARTY_NOTICES.md` },
];

const LINK_CLASS = "font-medium text-accent-text underline-offset-2 hover:underline";

/**
 * Where Ancilla comes from and under what terms: AGPL, forked from Helicon, which is MIT. Plain `target="_blank"` links, which
 * the desktop shell hands to the default browser.
 */
export function About(props: { version: string | null }) {
  return (
    <div className="px-4 py-3">
      <p className="text-sm text-pretty text-fg">
        Ancilla{props.version ? ` ${props.version}` : ""} · based on{" "}
        <a href="https://github.com/HarjjotSinghh/helicon" target="_blank" rel="noreferrer" className={LINK_CLASS}>
          Helicon
        </a>{" "}
        by Harjot Singh Rana and contributors (MIT) · GNU AGPL v3
      </p>
      <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {LEGAL_LINKS.map((link) => (
          <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 ${LINK_CLASS}`}>
            {link.label} <ArrowSquareOutIcon size={11} />
          </a>
        ))}
      </p>
    </div>
  );
}
