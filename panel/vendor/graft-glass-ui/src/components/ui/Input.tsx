"use client";

import { forwardRef, useId, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const FIELD =
  "w-full px-4 py-3 bg-ink/[0.03] border border-ink/[0.06] rounded-xl text-[15px] font-[400] text-ink placeholder:text-ink/45 focus:outline-none focus:border-ink/15 transition-colors duration-200";

type FieldChrome = {
  label?: string;
  help?: string;
  error?: string;
};

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & FieldChrome
>(function Input({ label, help, error, className, id, ...props }, ref) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <div>
      {label ? (
        <label htmlFor={fieldId} className="block text-[12px] font-[350] text-ink/35 mb-2">
          {label}
        </label>
      ) : null}
      <input ref={ref} id={fieldId} className={cn(FIELD, className)} {...props} />
      {help && !error ? <p className="text-[11px] text-ink/35 mt-1.5">{help}</p> : null}
      {error ? <p className="text-[11px] text-[rgba(239,68,68,0.9)] mt-1.5">{error}</p> : null}
    </div>
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & FieldChrome
>(function Textarea({ label, help, error, className, id, ...props }, ref) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <div>
      {label ? (
        <label htmlFor={fieldId} className="block text-[12px] font-[350] text-ink/35 mb-2">
          {label}
        </label>
      ) : null}
      <textarea ref={ref} id={fieldId} className={cn(FIELD, "resize-none", className)} {...props} />
      {help && !error ? <p className="text-[11px] text-ink/35 mt-1.5">{help}</p> : null}
      {error ? <p className="text-[11px] text-[rgba(239,68,68,0.9)] mt-1.5">{error}</p> : null}
    </div>
  );
});
