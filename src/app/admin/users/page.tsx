import { Flash, type FlashParams } from "@/components/admin/Flash";
import { RuntimeSettings } from "@/components/admin/RuntimeSettings";
import { AdminHeader, Card, StatusPill, Table, td, th } from "@/components/admin/ui";
import { Button, Field, Input, Select } from "@/components/ui/form";
import { adminActor } from "@/lib/admin";
import { formatDate } from "@/lib/dates";
import { flash } from "@/lib/flash";
import { requireRole } from "@/lib/session";
import { PASSWORD_HINT, PASSWORD_MAX, PASSWORD_MIN } from "@/lib/password-policy";
import { createUser, deleteUser, inviteDemoUser, listUsers, setBanned, setRole } from "@/lib/users";

export const metadata = { title: "Users" };

async function role(form: FormData) {
  "use server";
  const actor = await adminActor();
  await flash("/admin/users", async () => {
    await setRole(actor, String(form.get("id")), String(form.get("role")));
    return "Role updated.";
  });
}

async function invite(form: FormData) {
  "use server";
  const actor = await adminActor();
  await flash("/admin/users", async () => {
    const email = String(form.get("email") ?? "").trim();
    const result = await inviteDemoUser(actor, { email, name: form.get("name") });
    return result === "resent" ? `A new invitation link was sent to ${email}.` : result === "converted" ? `${email} is now a demo account and has been sent an invitation.` : `Invitation sent to ${email}.`;
  });
}

async function create(form: FormData) {
  "use server";
  const actor = await adminActor();
  await flash("/admin/users", async () => {
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    await createUser(actor, { email, name: form.get("name"), role: form.get("role"), password: form.get("password") });
    return `Account created for ${email}. Share the password with them yourself; no email was sent.`;
  });
}

async function ban(form: FormData) {
  "use server";
  const actor = await adminActor();
  await flash("/admin/users", async () => {
    const banned = form.get("banned") === "true";
    await setBanned(actor, String(form.get("id")), banned);
    return banned ? "User banned and signed out." : "User unbanned.";
  });
}

async function remove(form: FormData) {
  "use server";
  const actor = await adminActor();
  await flash("/admin/users", async () => {
    await deleteUser(actor, String(form.get("id")));
    return "User deleted.";
  });
}

export default async function UsersPage({ searchParams }: { searchParams: FlashParams }) {
  const me = await requireRole("admin");
  const [rows, sp] = await Promise.all([listUsers(), searchParams]);
  return (
    <>
      <AdminHeader title="Users" description="Readers, authors, admins and demo accounts. Authors can write and publish their own posts. Demo accounts see the whole admin but cannot change anything. Members-only articles and profile picture limits are at the end of the page." />
      <Flash ok={sp.ok} error={sp.error} />
      <Card className="mb-6">
        <h2 className="text-base font-semibold text-fg">Invite demo users</h2>
        <p className="mt-1 text-sm text-fg-muted">
          For product demonstrations. A demo account sees every admin page you see, but cannot save, publish, delete, send or run anything,
          and cannot download backups. The person gets an email with a link to choose a password. Invite as many as you like; ban or delete one to end access.
        </p>
        <form action={invite} className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
          <Field label="Email" htmlFor="invite-email">
            <Input id="invite-email" name="email" type="email" required maxLength={254} autoComplete="off" placeholder="name@company.com" />
          </Field>
          <Field label="Name" htmlFor="invite-name" optional>
            <Input id="invite-name" name="name" maxLength={80} autoComplete="off" />
          </Field>
          <Button type="submit">Send invitation</Button>
        </form>
      </Card>
      <Card className="mb-6">
        <h2 className="text-base font-semibold text-fg">Add a user with a password</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Creates the account straight away with a password you choose, for any role. No email is sent, so share the password yourself.
          {PASSWORD_HINT}
        </p>
        <form action={create} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_minmax(0,1.5fr)_auto] lg:items-end">
          <Field label="Email" htmlFor="create-email">
            <Input id="create-email" name="email" type="email" required maxLength={254} autoComplete="off" placeholder="name@company.com" />
          </Field>
          <Field label="Name" htmlFor="create-name" optional>
            <Input id="create-name" name="name" maxLength={80} autoComplete="off" />
          </Field>
          <Field label="Role" htmlFor="create-role">
            <Select id="create-role" name="role" defaultValue="demo" className="py-2">
              <option value="user">Reader</option>
              <option value="author">Author</option>
              <option value="demo">Demo (read-only)</option>
              <option value="admin">Admin</option>
            </Select>
          </Field>
          <Field label="Password" htmlFor="create-password">
            <Input id="create-password" name="password" type="password" required minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} autoComplete="new-password" />
          </Field>
          <Button type="submit">Create user</Button>
        </form>
      </Card>
      <Table head={<tr><th className={th}>User</th><th className={th}>Role</th><th className={th}>Status</th><th className={th}>Joined</th><th className={th}>Actions</th></tr>}>
        {rows.map(({ user: u, profile }) => (
          <tr key={u.id}>
            <td className={td}>
              <p className="font-medium text-fg">{u.name}{u.id === me.id && " (you)"}</p>
              <p className="text-xs text-slate-500">{u.email}{profile && ` · /authors/${profile}`}</p>
            </td>
            <td className={td}>
              <form action={role} className="flex items-center gap-2">
                <input type="hidden" name="id" value={u.id} />
                <Select name="role" defaultValue={u.role} aria-label={`Role for ${u.name}`} disabled={u.id === me.id} className="w-28 py-1.5">
                  <option value="user">Reader</option>
                  <option value="author">Author</option>
                  <option value="demo">Demo (read-only)</option>
                  <option value="admin">Admin</option>
                </Select>
                {u.id !== me.id && <Button type="submit" variant="secondary" className="px-3 py-1.5">Save</Button>}
              </form>
            </td>
            <td className={td}><StatusPill status={u.banned ? "spam" : u.emailVerified ? "approved" : "pending"} /> <span className="text-xs text-slate-500">{u.banned ? "banned" : u.emailVerified ? "verified" : "unverified"}</span></td>
            <td className={`${td} whitespace-nowrap`}>{formatDate(u.createdAt.toISOString())}</td>
            <td className={td}>
              {u.id !== me.id && (
                <div className="flex gap-2">
                  {u.role === "demo" && !u.banned && (
                    <form action={invite}>
                      <input type="hidden" name="email" value={u.email} />
                      <Button type="submit" variant="secondary" className="px-3 py-1.5">Resend invite</Button>
                    </form>
                  )}
                  <form action={ban}>
                    <input type="hidden" name="id" value={u.id} />
                    <input type="hidden" name="banned" value={u.banned ? "false" : "true"} />
                    <Button type="submit" variant="secondary" className="px-3 py-1.5">{u.banned ? "Unban" : "Ban"}</Button>
                  </form>
                  <form action={remove}>
                    <input type="hidden" name="id" value={u.id} />
                    <Button type="submit" variant="ghost" className="px-3 py-1.5">Delete</Button>
                  </form>
                </div>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <div className="mt-10 space-y-6">
        <RuntimeSettings ids={["members", "avatars"]} />
      </div>
    </>
  );
}
