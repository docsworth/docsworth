// domino's own declarations name the module `domino` and need the DOM lib; the oracle
// only reads the text a document's body shows.
declare module "@mixmark-io/domino" {
  export function createDocument(html?: string): { body: { textContent: string | null } };
}
