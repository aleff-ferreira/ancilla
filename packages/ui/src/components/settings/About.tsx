import type { ReactElement } from "react";
import { ArrowSquareOutIcon } from "../ui/icons.js";

const ANCILLA_SOURCE_REPO = "https://github.com/aleff-ferreira/ancilla";
const REPOSITORY_BLOB_PREFIX = `${ANCILLA_SOURCE_REPO}/blob/main`;

export interface LegalNoticeLink {
  readonly label: string;
  readonly href: string;
}

/** Active statutory legal notices and licensing disclosures governing Ancilla. */
export const LEGAL_LINKS: readonly LegalNoticeLink[] = Object.freeze([
  {
    label: "License",
    href: `${REPOSITORY_BLOB_PREFIX}/LICENSE`,
  },
  {
    label: "Notice",
    href: `${REPOSITORY_BLOB_PREFIX}/NOTICE.md`,
  },
  {
    label: "Third-party notices",
    href: `${REPOSITORY_BLOB_PREFIX}/THIRD_PARTY_NOTICES.md`,
  },
]);

export interface AboutProps {
  readonly version: string | null;
  readonly remoteDeployment?: boolean;
  readonly sourceOfferUrl?: string | null;
}

const LEGAL_ANCHOR_STYLE = "inline-flex items-center gap-1 font-medium text-brand-text underline-offset-2 hover:underline";

/**
 * About settings panel displaying versioning metadata, GNU AGPL v3 licensing,
 * statutory legal notices, and AGPLv3 section 13 source distribution disclosures.
 */
export function About({ version, remoteDeployment, sourceOfferUrl }: AboutProps): ReactElement {
  const effectiveRelease = version?.trim();
  const canonicalSourceHref = sourceOfferUrl?.trim() || ANCILLA_SOURCE_REPO;

  return (
    <section className="px-4 py-3" aria-label="About Ancilla">
      <p className="text-sm text-pretty text-fg">
        {effectiveRelease ? `Ancilla ${effectiveRelease}` : "Ancilla"} · GNU AGPL v3
      </p>
      <p className="mt-1 text-xs text-muted">An AMAZONIA WORKS product</p>
      <nav aria-label="Legal links" className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {LEGAL_LINKS.map(({ label, href }) => (
          <a
            key={href}
            href={href}
            target="_blank"
            rel="noreferrer"
            className={LEGAL_ANCHOR_STYLE}
          >
            {label} <ArrowSquareOutIcon size={11} />
          </a>
        ))}
      </nav>
      {remoteDeployment ? (
        <aside className="mt-2.5 rounded-lg border border-line bg-sunken px-3 py-2 text-xs leading-relaxed text-muted">
          Remote network deployment active (GNU AGPLv3 §13):{" "}
          <a
            href={canonicalSourceHref}
            target="_blank"
            rel="noreferrer"
            className={LEGAL_ANCHOR_STYLE}
          >
            Complete Corresponding Source Code <ArrowSquareOutIcon size={11} />
          </a>
        </aside>
      ) : null}
    </section>
  );
}
