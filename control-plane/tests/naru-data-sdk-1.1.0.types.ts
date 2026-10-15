// What 1.1.0 adds to 1.0.0's types (naru-data-sdk.types.ts): members, and
// the author every document carries.
import {
  createNaru,
  type Admin,
  type Document,
  type Collection,
  type Member,
  type PublicCollection,
} from "../public/sdk/1.1.0/naru.js";

interface Profile {
  nick: string;
}
const naru = createNaru({ site: "alice" });

async function members() {
  const member: Member | null = await naru.members.session();
  if (!member) return naru.members.signIn();
  const id: string = member.id;
  // @ts-expect-error A member's id is the site's to read, not to change.
  member.id = "someone";
  const profiles: Collection<Profile> =
    member.collection<Profile>("profiles");
  const mine: Document<Profile> = await profiles.set(id, { nick: "bob" });
  const author: string | null = mine.createdBy;
  await profiles.delete(id, { condition: { revision: mine.revision } });
  // @ts-expect-error Data keeps its type.
  await profiles.add({ nick: 1 });
  // A member's handle is a visitor's handle, and more.
  const visitor: PublicCollection<Profile> = profiles;
  const file = await member.media.upload(new Blob(["x"]), {
    onProgress: (progress) => progress.phase,
  });
  const url: string = file.url;
  // @ts-expect-error Batches are the owner's.
  void member.batch;
  await member.signOut();
  void [author, visitor, url];
}

async function owner() {
  const admin: Admin | null = await naru.auth.session();
  // Sign-in for members takes no collections.
  // @ts-expect-error
  await naru.members.signIn({ collections: ["posts"] });
  void admin;
}
void [members, owner];
