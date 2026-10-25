// What 1.1.0 adds to 1.0.0's types (naru-data-sdk.types.ts): the site's
// queries and mutations, live queries, and members.
import {
  createNaru,
  // @ts-expect-error The types Naru Media stores are site code's ctx.media.types.
  MEDIA_TYPES,
  type Admin,
  type AdminCollection,
  type Live,
  type Member,
  type NaruError,
  type PublicCollection,
} from "../public/sdk/1.1.0/naru.js";

interface Post {
  title: string;
}
const naru = createNaru({ site: "alice" });

async function members() {
  const member: Member | null = await naru.members.session();
  if (!member) return naru.members.signIn();
  const id: string = member.id;
  // @ts-expect-error A member's id is the site's to read, not to change.
  member.id = "someone";
  // Members reach the site's data through its queries and mutations.
  // @ts-expect-error Collections are the owner's and visitors', as in 1.0.0.
  void member.collection;
  const posts = await member.query<Post[]>("community/posts:list", {
    board: "free",
  });
  const written: number = await member.mutate<number>("community/posts:add", {
    title: "hi",
  });
  const live: Live = member.subscribe<Post[]>(
    "community/posts:list",
    { board: "free" },
    (result) => void result[0]?.title,
    { onError: (error: NaruError) => void error.code },
  );
  live.close();
  const file = await member.media.upload(new Blob(["x"]), {
    onProgress: (progress) => progress.phase,
  });
  const url: string = file.url;
  // @ts-expect-error Uploads are deleted in the owner's media library.
  void member.media.delete;
  // @ts-expect-error Batches are the owner's.
  void member.batch;
  // @ts-expect-error Site functions and live messages are gone.
  void member.call;
  await member.signOut();
  void [id, posts, written, url];
}

async function visitors() {
  // A visitor's handle is 1.0.0's: reading and adding.
  const posts: PublicCollection<Post> = naru.collection<Post>("posts");
  await posts.add({ title: "hi" });
  // @ts-expect-error Replacing is the owner's.
  void posts.set;
  // @ts-expect-error Batch reads are gone.
  void posts.getMany;
  // @ts-expect-error As are predicates.
  await posts.list({ where: { eq: ["title", "hi"] } });
  // @ts-expect-error And live topics.
  void naru.live;
  await naru.query("community/posts:list");
}

async function owner() {
  const admin: Admin | null = await naru.auth.session();
  if (!admin) return naru.auth.signIn();
  const posts: AdminCollection<Post> = admin.collection<Post>("posts");
  const added = await posts.add({ title: "hi" });
  await posts.set(added.id, { title: "bye" });
  // @ts-expect-error Documents carry no author in 1.1.0's types, as in 1.0.0.
  void added.createdBy;
  await admin.mutate("community/posts:add", { title: "owner" });
  // @ts-expect-error Pages never delete uploads, the owner's included.
  void admin.media.delete;
  // @ts-expect-error So no sign-in asks for it.
  await naru.auth.signIn({ collections: ["posts"], mediaDelete: true });
  // Sign-in for members takes no collections.
  // @ts-expect-error
  await naru.members.signIn({ collections: ["posts"] });
}
void [members, visitors, owner, MEDIA_TYPES];
