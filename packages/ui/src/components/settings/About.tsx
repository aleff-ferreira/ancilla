import { ArrowSquareOutIcon } from "../ui/icons.js";

const REPO = "https://github.com/aleff-ferreira/ancilla";

/** The license and notices every copy of Ancilla carries, as published with its source. */
export const LEGAL_LINKS: readonly { label: string; href: string }[] = [
  { label: "License", href: `${REPO}/blob/main/LICENSE` },
  { label: "Helicon license", href: `${REPO}/blob/main/LICENSE-HELICON` },
  { label: "Notice", href: `${REPO}/blob/main/NOTICE.md` },
  { label: "Third-party notices", href: `${REPO}/blob/main/THIRD_PARTY_NOTICES.md` },
];

const LINK_CLASS = "font-medium text-accent-text underline-offset-2 hover:underline";

/**
 * The version and the license, with the legal texts a click away. Plain `target="_blank"` links, which
 * the desktop shell hands to the default browser.
 */
export function About(props: { version: string | null }) {
  return (
    <div className="px-4 py-3">
      <p className="text-sm text-pretty text-fg">
        Ancilla{props.version ? ` ${props.version}` : ""} · GNU AGPL v3
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
