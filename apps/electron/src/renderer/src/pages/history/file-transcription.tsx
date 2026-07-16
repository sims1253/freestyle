import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { getApiBase, getClient } from "@renderer/lib/api";
import { decodeAudioFileToWav } from "@renderer/lib/audio-file";
import { Check, Copy, FileAudio, LoaderCircle, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type State = "idle" | "decoding" | "transcribing" | "complete" | "error";

interface FileTranscriptionResult {
  raw: string;
  cleaned: string;
}

interface StarlingStatus {
  phase: string | null;
}

export function FileTranscription({
  onComplete,
}: {
  onComplete: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>("idle");
  const [fileName, setFileName] = useState("");
  const [phase, setPhase] = useState<string | null>(null);
  const [result, setResult] = useState<FileTranscriptionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (state !== "transcribing") return;
    const poll = async (): Promise<void> => {
      try {
        const response = await getClient().api.starling.status.$get();
        if (response.ok)
          setPhase(((await response.json()) as StarlingStatus).phase);
      } catch {
        // The request itself remains the source of truth; polling is visual only.
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 1_000);
    return () => window.clearInterval(interval);
  }, [state]);

  const chooseFile = useCallback(() => inputRef.current?.click(), []);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setOpen(true);
      setFileName(file.name);
      setResult(null);
      setError(null);
      setPhase(null);
      setCopied(false);

      try {
        setState("decoding");
        const wav = await decodeAudioFileToWav(file);
        setState("transcribing");
        const response = await fetch(`${getApiBase()}/api/transcribe-file`, {
          method: "POST",
          body: wav,
          headers: { "Content-Type": "audio/wav" },
        });
        const body = (await response.json()) as
          | FileTranscriptionResult
          | { error?: string; detail?: string };
        if (!response.ok) {
          throw new Error(
            "detail" in body && body.detail
              ? body.detail
              : "error" in body && body.error
                ? body.error
                : "Transcription failed.",
          );
        }
        setResult(body as FileTranscriptionResult);
        setState("complete");
        onComplete();
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Transcription failed.",
        );
        setState("error");
      }
    },
    [onComplete],
  );

  const copyResult = useCallback(async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.cleaned || result.raw);
    setCopied(true);
  }, [result]);

  const busy = state === "decoding" || state === "transcribing";
  const status =
    state === "decoding"
      ? "Preparing audio…"
      : phase
        ? `Starling: ${phase}`
        : "Transcribing with Starling…";

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="audio/wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/flac,audio/ogg,.wav,.mp3,.m4a,.flac,.ogg"
        className="sr-only"
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <Button variant="outline" size="sm" onClick={chooseFile}>
        <FileAudio data-icon="inline-start" />
        Transcribe file
      </Button>

      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileAudio className="text-primary h-4 w-4" />
              File transcription
            </DialogTitle>
            <DialogDescription>
              {fileName || "Choose an audio file to transcribe."}
            </DialogDescription>
          </DialogHeader>

          {busy && (
            <div className="border-primary/20 bg-primary/5 flex items-center gap-3 rounded-xl border px-4 py-4">
              <LoaderCircle className="text-primary h-5 w-5 animate-spin" />
              <div>
                <p className="text-sm font-medium">{status}</p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  Longer recordings can take several minutes.
                </p>
              </div>
            </div>
          )}

          {state === "idle" && (
            <Button variant="ink" onClick={chooseFile}>
              <Upload data-icon="inline-start" />
              Choose audio file
            </Button>
          )}

          {state === "error" && (
            <p className="text-destructive text-sm">{error}</p>
          )}

          {result && (
            <div className="border-border bg-muted/30 rounded-xl border p-4">
              <p className="text-foreground whitespace-pre-wrap text-sm leading-relaxed">
                {result.cleaned || result.raw || "No speech was detected."}
              </p>
              {result.raw &&
                result.cleaned &&
                result.raw !== result.cleaned && (
                  <p className="text-muted-foreground mt-3 border-t pt-3 text-xs leading-relaxed">
                    Original: {result.raw}
                  </p>
                )}
            </div>
          )}

          <DialogFooter>
            {result && (
              <Button variant="outline" onClick={() => void copyResult()}>
                {copied ? (
                  <Check data-icon="inline-start" />
                ) : (
                  <Copy data-icon="inline-start" />
                )}
                {copied ? "Copied" : "Copy result"}
              </Button>
            )}
            {!busy && state !== "complete" && (
              <Button variant="ink" onClick={chooseFile}>
                Choose another file
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
