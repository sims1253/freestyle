import { Button } from "@renderer/components/ui/button";
import { getClient } from "@renderer/lib/api";
import { Mic } from "lucide-react";
import { useState } from "react";

/**
 * Starling-only onboarding. Provider selection and cloud authentication belong
 * to cleanup settings now; dictation always starts from the local Granite
 * Starling model.
 */
export default function OnboardingPage(): React.JSX.Element {
  const [saving, setSaving] = useState(false);

  const finish = async (): Promise<void> => {
    setSaving(true);
    try {
      await getClient().api.models.configured.$post({
        json: {
          provider: "local-starling",
          model_id: "local-starling/granite",
          model_name: "Granite Speech 4.1 (2B)",
          type: "voice",
          is_default: true,
        },
      });
      window.api?.setOnboardingComplete();
      window.location.hash = "#/";
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <section className="border-border bg-card w-full max-w-xl rounded-[16px] border p-8 text-center shadow-sm">
        <div className="bg-primary/10 text-primary mx-auto flex size-12 items-center justify-center rounded-xl">
          <Mic className="size-5" />
        </div>
        <p className="mono text-muted-foreground mt-6 text-[10px] tracking-[0.16em] uppercase">
          Local dictation
        </p>
        <h1 className="serif text-foreground mt-2 text-4xl leading-none">
          Starling is ready to configure.
        </h1>
        <p className="text-muted-foreground mx-auto mt-4 max-w-md text-sm leading-relaxed">
          Freestyle uses your local Starling Python environment for dictation.
          You can set its Python path and choose another Starling model in
          Settings after setup.
        </p>
        <Button
          className="mt-7"
          onClick={() => void finish()}
          disabled={saving}
        >
          {saving ? "Setting up…" : "Continue with Granite"}
        </Button>
      </section>
    </main>
  );
}
