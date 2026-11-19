import React from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convexApi";
import { DB } from "@/data";
import { Icon } from "@/components/icons";
import { fmtTB, TIER_META, Badge, Seg, PageHead } from "@/components/components";
const h: any = React.createElement;

type ScreenProps = Record<string, any>;
type WizardForm = Record<string, any> & { rules: { rawKeep: boolean; proxyDelete: boolean; cacheDelete: boolean; finalKeep: boolean; licenseKeep: boolean } };
type WizardSet = (key: string, value: any) => void;



/* ============================================================
   DriveOS — Create Project Wizard
   ============================================================ */

  
  

  const STEPS = ["Project basics", "Storage setup", "Folder template", "Rules", "Confirm"];

  function FolderTree({ template, clientSlug }: ScreenProps) {
    const root = (clientSlug || "CLIENT_Show_ProjectName") + "/";
    return h("div", { className: "tree", style: { background: "var(--bg-input)", borderRadius: "var(--r)", padding: "14px 16px", border: "1px solid var(--line)", maxHeight: 420, overflowY: "auto" } },
      h("div", { className: "tree-row" }, h(Icon, { name: "folder", size: 13, style: { color: "var(--accent-hi)" } }), h("span", { className: "hi" }, root)),
      h("div", { className: "tree-indent" }, DB.folderTemplate.map((f, i) => h("div", { key: i, className: "tree-row", style: { marginLeft: f.lvl ? 20 : 0 } },
        h(Icon, { name: "folder", size: 12, style: { color: f.lvl ? "var(--tx-dim)" : "var(--tx-mut)" } }),
        h("span", { className: "tree-new", style: { color: f.lvl ? "var(--tx-mut)" : "var(--tx)", fontWeight: f.lvl ? 400 : 500 } }, f.name)))));
  }

  const TEMPLATE_NAMES: Record<string, string> = {
    youtube: "YouTube Show",
    film: "Brand Film",
    podcast: "Podcast",
    social: "Social Campaign",
    blank: "Blank",
  };

  function CreateWizard({ go, toast }: ScreenProps) {
    const [step, setStep] = React.useState(0);
    const [createdProjectId, setCreatedProjectId] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);
    const createProject = useMutation(api.projects.create);
    // Default the owner to the first real team member (or empty until one loads).
    const firstOwner = (DB.team && DB.team[0] && DB.team[0].id) || "";
    const firstDrive = DB.drives.find((d) => d.status !== "cloud" && d.status !== "uninit");
    const [form, setForm] = React.useState<WizardForm>({
      client: "", show: "", name: "", owner: firstOwner, due: "", status: "active",
      drive: firstDrive?.id || "", root: firstDrive?.mountPath || "", tier: "hot", cloud: false, template: "youtube",
      rules: { rawKeep: true, proxyDelete: true, cacheDelete: true, finalKeep: true, licenseKeep: true },
    });
    // Keep the owner valid once real members load.
    React.useEffect(() => {
      if (!form.owner && firstOwner) setForm((f) => ({ ...f, owner: firstOwner }));
    }, [firstOwner, form.owner]);
    React.useEffect(() => {
      if (!form.drive && firstDrive) setForm((f) => ({ ...f, drive: firstDrive.id, root: f.root || firstDrive.mountPath || "" }));
    }, [form.drive, firstDrive?.id, firstDrive?.mountPath]);
    const set: WizardSet = (k, v) => setForm((f) => ({ ...f, [k]: v }));
    const folderPart = (value: string) => value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, "_").replace(/[. ]+$/g, "");
    const clientSlug = form.client && form.name ? [form.client, form.show ? form.show.split(" ")[0] : "", form.name].filter(Boolean).map(folderPart).join("_") : "";

    if (createdProjectId) return h(SuccessScreen, { form, projectId: createdProjectId, go });

    const canNext = step === 0 ? Boolean(form.client.trim() && form.name.trim() && form.owner) : step === 1 ? Boolean(form.drive && form.root.trim()) : true;

    return h("div", { className: "page-inner", style: { maxWidth: 1080 } },
      h("button", { className: "btn ghost sm", style: { marginBottom: 12 }, onClick: () => go("projects") }, h(Icon, { name: "chevL", size: 15 }), "Cancel"),
      h(PageHead, { eyebrow: "Projects", title: "Create Project", desc: "Create a project record and queue the studio's local folder structure and setup manifest." }),

      // stepper
      h("div", { className: "card card-pad fade-up wizard-stepper", style: { marginBottom: "var(--gap)", display: "flex", gap: 0, alignItems: "center" } },
        STEPS.map((s, i) => h(React.Fragment, { key: i },
          h("div", { className: "row wizard-step", style: { gap: 10, cursor: i < step ? "pointer" : "default" }, onClick: () => i < step && setStep(i) },
            h("span", { style: { width: 28, height: 28, borderRadius: 99, display: "grid", placeItems: "center", flexShrink: 0, fontSize: 12, fontWeight: 700, fontFamily: "var(--font-mono)",
              background: i < step ? "var(--ok)" : i === step ? "var(--accent)" : "var(--bg-elevated)", color: i <= step ? "#fff" : "var(--tx-dim)", border: i === step ? "none" : "1px solid var(--line)" } },
              i < step ? h(Icon, { name: "check", size: 14, stroke: 3 }) : i + 1),
            h("span", { style: { fontSize: 12.5, fontWeight: 600, color: i === step ? "var(--tx-hi)" : "var(--tx-mut)", whiteSpace: "nowrap" } }, s)),
          i < STEPS.length - 1 && h("div", { className: "wizard-step-line", style: { flex: 1, height: 1.5, background: i < step ? "var(--ok)" : "var(--line)", margin: "0 14px" } })))),

      // step content
      h("div", { className: "card card-pad fade-up", style: { marginBottom: "var(--gap)", minHeight: 380 } },
        step === 0 && h(Step0, { form, set }),
        step === 1 && h(Step1, { form, set }),
        step === 2 && h(Step2, { form, set, clientSlug }),
        step === 3 && h(Step3, { form, set }),
        step === 4 && h(Step4, { form, clientSlug })),

      // nav
      h("div", { className: "spread" },
        h("button", { className: "btn", disabled: step === 0, onClick: () => setStep((s) => s - 1) }, h(Icon, { name: "chevL", size: 15 }), "Back"),
        h("div", { className: "row", style: { gap: 10 } },
          h("span", { className: "mono dim", style: { fontSize: 12 } }, "Step " + (step + 1) + " of " + STEPS.length),
          step < STEPS.length - 1
            ? h("button", { className: "btn primary", disabled: !canNext, onClick: () => setStep((s) => s + 1) }, "Continue", h(Icon, { name: "chevR", size: 15 }))
            : h("button", { className: "btn primary lg", disabled: saving, onClick: () => submit() }, h(Icon, { name: "zap", size: 16 }), saving ? "Creating…" : "Create Project"))));

    async function submit() {
      if (saving) return;
      setSaving(true);
      try {
        const dueMs = form.due ? new Date(form.due).getTime() : undefined;
        const parentRoot = form.root.replace(/\\/g, "/").replace(/\/+$/, "");
        const rootPath = `${parentRoot}/${clientSlug}`;
        const projectId = await createProject({
          name: form.name,
          client: form.client,
          showName: form.show || undefined,
          ownerId: form.owner,
          status: form.status,
          tier: form.tier,
          rootPath: rootPath || undefined,
          template: TEMPLATE_NAMES[form.template] || "YouTube Show",
          dueDate: dueMs && !Number.isNaN(dueMs) ? dueMs : undefined,
          driveId: form.drive,
          rules: form.rules,
          cloudRequested: false,
        });
        setCreatedProjectId(projectId);
        toast("Project saved — folder setup queued for its agent", "clock", "accent");
      } catch (err: any) {
        toast(err?.message || "Could not create project", "alert", "risk");
      } finally {
        setSaving(false);
      }
    }
  }

  function Field({ label, children, hint }: ScreenProps) {
    return h("div", null, h("label", { className: "field-label" }, label), children, hint && h("div", { className: "dim", style: { fontSize: 11, marginTop: 5 } }, hint));
  }

  function Step0({ form, set }: ScreenProps) {
    return h("div", null,
      h(StepHead, { n: "01", title: "Project basics", desc: "Who is this for and what are we building?" }),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 } },
        h(Field, { label: "Client" }, h("input", { className: "input", placeholder: "e.g. Northwind", value: form.client, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set("client", e.target.value) })),
        h(Field, { label: "Show / Campaign" }, h("input", { className: "input", placeholder: "e.g. Show X (YouTube)", value: form.show, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set("show", e.target.value) })),
        h(Field, { label: "Episode / Project name" }, h("input", { className: "input", placeholder: "e.g. Ep. 215", value: form.name, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set("name", e.target.value) })),
        h(Field, { label: "Owner / Editor" }, h("select", { className: "select", style: { width: "100%" }, value: form.owner, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => set("owner", e.target.value) },
          (DB.team && DB.team.length > 0)
            ? DB.team.map((m) => h("option", { key: m.id, value: m.id }, m.name + " — " + m.role))
            : h("option", { value: "" }, "Add team members in Settings first"))),
        h(Field, { label: "Due date" }, h("input", { className: "input", type: "date", value: form.due, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set("due", e.target.value) })),
        h(Field, { label: "Initial status" }, h("div", { style: { paddingTop: 2 } }, h(Seg, { value: form.status, onChange: (v: string) => set("status", v), options: [{ value: "active", label: "Active" }, { value: "review", label: "Review" }] })))));
  }

  function Step1({ form, set }: ScreenProps) {
    return h("div", null,
      h(StepHead, { n: "02", title: "Storage setup", desc: "Where does the project live, and how is it tiered?" }),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: 20 } },
        h(Field, { label: "Drive", hint: DB.driveById[form.drive] ? fmtTB(DB.driveById[form.drive].capTB - DB.driveById[form.drive].usedTB) + " free" : "" },
          h("select", { className: "select", style: { width: "100%" }, value: form.drive, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { set("drive", e.target.value); const drive = DB.driveById[e.target.value]; if (drive?.mountPath) set("root", drive.mountPath); } },
            h("option", { value: "", disabled: true }, "Select a tracked drive"),
            DB.drives.filter((d) => d.status !== "cloud" && d.status !== "uninit").map((d) => h("option", { key: d.id, value: d.id }, d.name)))),
        h(Field, { label: "Root folder" }, h("input", { className: "input mono", value: form.root, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set("root", e.target.value) }))),
      h(Field, { label: "Storage tier" },
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 4 } },
          [["hot", "Hot", "Live editing SSD", "risk"], ["warm", "Warm", "Near-line RAID", "warn"], ["cold", "Cold", "Archive drive", "auto"]].map(([k, label, desc, c]) =>
            h("div", { key: k, onClick: () => set("tier", k), style: { padding: 15, borderRadius: "var(--r)", cursor: "pointer", background: form.tier === k ? "var(--accent-soft)" : "var(--bg-surface)", border: "1px solid " + (form.tier === k ? "var(--accent-line)" : "var(--line)") } },
              h("div", { className: "row", style: { gap: 8, marginBottom: 5 } }, h("span", { style: { width: 9, height: 9, borderRadius: 2, background: "var(--" + c + ")" } }), h("span", { className: "hi", style: { fontWeight: 600, fontSize: 13.5 } }, label)),
              h("div", { className: "muted", style: { fontSize: 12 } }, desc))))),
      h("div", { className: "spread", style: { marginTop: 20, padding: "14px 16px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
        h("div", { className: "row", style: { gap: 11 } }, h(Icon, { name: "cloud", size: 18, style: { color: "var(--cloud)" } }),
            h("div", null, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 13 } }, "Cloud folders unavailable"), h("div", { className: "muted", style: { fontSize: 12 } }, "This setup creates local folders and a manifest. Cloud mirroring is not connected.")))));
  }

  function Step2({ form, set, clientSlug }: ScreenProps) {
    return h("div", null,
      h(StepHead, { n: "03", title: "Folder template", desc: "Pick a structure — the tree previews live on the right." }),
      h("div", { style: { display: "grid", gridTemplateColumns: "300px 1fr", gap: 22 } },
        h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } }, DB.templates.map((t) =>
          h("div", { key: t.id, onClick: () => set("template", t.id), style: { padding: 14, borderRadius: "var(--r)", cursor: "pointer", background: form.template === t.id ? "var(--accent-soft)" : "var(--bg-surface)", border: "1px solid " + (form.template === t.id ? "var(--accent-line)" : "var(--line)") } },
            h("div", { className: "spread" }, h("span", { className: "hi", style: { fontWeight: 600, fontSize: 13.5 } }, t.name), form.template === t.id && h(Icon, { name: "checkCircle", size: 16, style: { color: "var(--accent-hi)" } })),
            h("div", { className: "muted", style: { fontSize: 11.5, marginTop: 3 } }, t.desc),
            t.folders > 0 && h("div", { className: "mono dim", style: { fontSize: 10.5, marginTop: 5 } }, t.folders + " folders")))),
        h("div", null,
          h("div", { className: "eyebrow", style: { marginBottom: 8 } }, "Folder preview"),
          h(FolderTree, { template: form.template, clientSlug }))));
  }

  function Step3({ form, set }: ScreenProps) {
    const rules: Array<[string, string, string, string, string]> = [
      ["rawKeep", "Raw footage — always protected", "Original camera footage is excluded from DriveOS cleanup.", "shield", "ok"],
      ["proxyDelete", "Proxies — deletable after delivery", "Generated proxies can be quarantined once the project ships.", "layers", "warn"],
      ["cacheDelete", "Cache — deletable anytime after confirmation", "Premiere / DaVinci cache is regenerable on next open.", "cpu", "warn"],
      ["finalKeep", "Final exports — must be kept", "Delivery masters are never auto-cleaned.", "download", "ok"],
      ["licenseKeep", "Licenses / admin docs — must be kept", "Music, SFX, and license paperwork stay with the archive.", "lock", "ok"],
    ];
    return h("div", null,
      h(StepHead, { n: "04", title: "Cleanup rules", desc: "How should DriveOS treat each file type in this project?" }),
      h("div", { style: { display: "flex", flexDirection: "column", gap: 11 } }, rules.map(([k, title, desc, icon, c]) =>
        h("div", { key: k, className: "spread", style: { padding: "13px 15px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
          h("div", { className: "row", style: { gap: 12 } },
            h("span", { style: { width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", flexShrink: 0, background: "var(--" + c + "-soft)", color: "var(--" + c + ")" } }, h(Icon, { name: icon, size: 16 })),
            h("div", null, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 13 } }, title), h("div", { className: "muted", style: { fontSize: 11.5 } }, desc))),
          ["rawKeep", "finalKeep", "licenseKeep"].includes(k)
            ? h(Badge, { kind: "ok", icon: "lock" }, "Always protected")
            : h(Toggle, { label: title, on: form.rules[k], onChange: (v: boolean) => set("rules", { ...form.rules, [k]: v }) })))));
  }

  function Step4({ form, clientSlug }: ScreenProps) {
    const owner = DB.teamById[form.owner] || { name: "Unknown" }, drive = DB.driveById[form.drive];
    return h("div", null,
      h(StepHead, { n: "05", title: "Confirm & create", desc: "Save the project and queue its folder structure and manifest on the selected drive's agent." }),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22 } },
        h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
          confirmRow("Project", (form.client || "—") + " · " + (form.name || "—")),
          confirmRow("Show / Campaign", form.show || "—"),
          confirmRow("Owner", owner.name),
          confirmRow("Due date", form.due || "Not set"),
          confirmRow("Drive", drive ? drive.name : "—"),
          confirmRow("Storage tier", TIER_META[form.tier === "cloud" ? "cloud" : form.tier].label),
          confirmRow("Root folder", form.root),
          confirmRow("Cloud folder", "Not connected"),
          confirmRow("Template", (DB.templates.find((t) => t.id === form.template) || {}).name)),
        h("div", null, h("div", { className: "eyebrow", style: { marginBottom: 8 } }, "Will be created"), h(FolderTree, { template: form.template, clientSlug }))));
  }

  function confirmRow(label: React.ReactNode, value: React.ReactNode) {
    return h("div", { className: "spread", style: { padding: "11px 14px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
      h("span", { className: "muted", style: { fontSize: 12.5 } }, label), h("span", { className: "hi", style: { fontWeight: 600, fontSize: 13, textAlign: "right" } }, value));
  }
  function StepHead({ n, title, desc }: ScreenProps) {
    return h("div", { style: { marginBottom: 22 } },
      h("div", { className: "row", style: { gap: 10, marginBottom: 4 } }, h("span", { className: "mono", style: { fontSize: 12, color: "var(--accent-hi)", fontWeight: 700 } }, n), h("h3", { style: { fontSize: 17 } }, title)),
      h("div", { className: "muted", style: { fontSize: 13 } }, desc));
  }
  function Toggle({ on, onChange, label }: ScreenProps) {
    return h("button", { type: "button", role: "switch", "aria-checked": Boolean(on), "aria-label": label || "Toggle project rule", onClick: () => onChange(!on), style: { width: 42, height: 24, borderRadius: 99, flexShrink: 0, cursor: "pointer", background: on ? "var(--accent)" : "var(--bg-elevated)", border: "1px solid " + (on ? "var(--accent-lo)" : "var(--line-strong)"), position: "relative", transition: "background .15s" } },
      h("span", { style: { position: "absolute", top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: 99, background: "#fff", transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,.4)" } }));
  }

  // ---- Success ----
  function SuccessScreen({ form, projectId, go }: ScreenProps) {
    const setup = useQuery(api.projects.setupStatus, { projectId });
    const completed = setup?.status === "completed";
    const failed = setup?.status === "failed";
    const running = setup?.status === "running";
    const steps = [
      [completed ? "Folder structure created" : failed ? "Folder setup failed" : running ? "Folder structure in progress" : "Folder structure queued", failed ? setup?.error || "Check the agent log for details." : completed ? "Agent confirmed local setup" : running ? "The selected agent is creating the local folders" : "Waiting for the selected drive's agent", "folder"],
      [completed ? "Archive manifest created" : "Archive manifest pending", "09_ARCHIVE_MANIFEST/project_manifest.json", "fingerprint"],
      ["Cloud mirroring not connected", "No cloud copy was created", "cloud"],
      ["Scan schedule unchanged", "Use the local app to manage scheduled scans", "eye"],
    ];
    return h("div", { className: "page-inner", style: { maxWidth: 680 } },
      h("div", { className: "card fade-up", style: { marginTop: 30, overflow: "hidden" } },
        h("div", { style: { padding: 32, textAlign: "center", borderBottom: "1px solid var(--line)", background: "linear-gradient(180deg, var(--ok-soft), transparent)" } },
          h("div", { style: { width: 60, height: 60, borderRadius: 16, margin: "0 auto 16px", display: "grid", placeItems: "center", background: "var(--ok-soft)", color: "var(--ok)", border: "1px solid var(--ok-line)", boxShadow: "0 0 30px var(--ok-soft)" } }, h(Icon, { name: "checkCircle", size: 30 })),
          h("h2", { style: { fontSize: 22 } }, completed ? "Project setup completed" : failed ? "Project saved — setup needs attention" : running ? "Project saved — setup in progress" : "Project saved — setup queued"),
          h("div", { className: "muted", style: { fontSize: 13.5, marginTop: 6 } }, (form.client || "Project") + " · " + (form.name || "New Project"))),
        h("div", { style: { padding: 8 } }, steps.map((s, i) => h("div", { key: i, className: "row", style: { gap: 13, padding: "13px 16px", borderBottom: i < steps.length - 1 ? "1px solid var(--line-faint)" : "none" } },
          h("span", { style: { width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", flexShrink: 0, background: "var(--bg-surface)", color: completed && i < 2 ? "var(--ok)" : "var(--tx-mut)" } }, h(Icon, { name: completed && i < 2 ? "check" : "info", size: 16, stroke: 3 })),
          h("div", { style: { flex: 1 } }, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 13.5 } }, s[0]), h("div", { className: "mono dim", style: { fontSize: 11.5 } }, s[1])),
          h(Icon, { name: s[2], size: 16, style: { color: "var(--tx-dim)" } })))),
        h("div", { className: "row", style: { gap: 10, padding: 18, borderTop: "1px solid var(--line)" } },
          h("button", { className: "btn", style: { flex: 1 }, onClick: () => go("projects") }, "All projects"),
          h("button", { className: "btn primary", style: { flex: 1 }, onClick: () => go("project", { id: projectId }) }, "Go to project dashboard", h(Icon, { name: "arrowR", size: 15 })))));
  }

  


export { CreateWizard };
