type Status =
  | "pending"
  | "hashing"
  | "uploading"
  | "backending"
  | "success"
  | "error"
  | "cancelled"
export interface UploadFileProps {
  id: string
  name: string
  path: string
  size: number
  progress: number
  speed: number
  status: Status
  msg?: string
}
export const StatusBadge = {
  pending: "neutral",
  hashing: "warning",
  uploading: "info",
  backending: "info",
  success: "success",
  error: "danger",
  cancelled: "warning",
} as const
export type SetUpload = (key: keyof UploadFileProps, value: any) => void
export type Upload = (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  asTask: boolean,
  overwrite: boolean,
  rapid: boolean,
  signal?: AbortSignal,
) => Promise<Error | undefined>
