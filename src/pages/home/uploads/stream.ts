import { password, getSettingBool, getSettingNumber } from "~/store"
import { EmptyResp } from "~/types"
import { r } from "~/utils"
import { SetUpload, Upload } from "./types"
import { calculateHash } from "./util"

const MAX_RETRIES = 3
const INITIAL_RETRY_DELAY_MS = 1000
const MIN_CHUNK_SIZE_MB = 5
const MAX_CHUNK_SIZE_MB = 90
const UPLOAD_CANCELLED_MESSAGE = "Upload cancelled"

function getChunkSizeBytes(): number {
  const configuredSize = getSettingNumber("chunked_upload_size", 50)
  const chunkSizeMB = Math.min(
    MAX_CHUNK_SIZE_MB,
    Math.max(
      MIN_CHUNK_SIZE_MB,
      Number.isFinite(configuredSize) ? configuredSize : 50,
    ),
  )
  return chunkSizeMB * 1024 * 1024
}

function isCancelledResp(resp: any): boolean {
  return resp?.code === -1
}

function isCancelledError(err: any): boolean {
  return (
    err?.message === UPLOAD_CANCELLED_MESSAGE ||
    err?.message === "canceled" ||
    err?.name === "CanceledError" ||
    err?.name === "AbortError"
  )
}

function throwUploadCancelled(): never {
  throw new Error(UPLOAD_CANCELLED_MESSAGE)
}

// Determine if an upload error response is transient (worth retrying).
// The response interceptor returns { code, message } for all errors:
//   code === -1       → cancelled by user (not transient)
//   code === undefined → network error (transient)
//   code >= 500       → server error (transient)
//   code < 500        → client error, e.g. 400/403/404 (not transient)
function isTransient(resp: any): boolean {
  if (resp == null || typeof resp !== "object") return false
  if (resp.code === -1) return false // user cancellation
  if (resp.code === undefined) return true // network error
  return resp.code >= 500 // server error
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(UPLOAD_CANCELLED_MESSAGE))
      return
    }
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(new Error(UPLOAD_CANCELLED_MESSAGE))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", abort)
  })
}

// Chunked upload: split file into chunks and upload via /fs/chunked/* endpoints.
// Automatically bypasses reverse proxy body size limits (Cloudflare 100MB, etc.)
const ChunkedUpload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  asTask: boolean,
  overwrite: boolean,
  hashValues?: { md5: string; sha1: string; sha256: string },
  signal?: AbortSignal,
): Promise<void> => {
  const requestedChunkSize = getChunkSizeBytes()
  const pwd = password()

  // Step 1: Create session
  const createResp: any = await r.post(
    "/fs/chunked/create",
    {
      size: file.size,
      chunk_size: requestedChunkSize,
      name: file.name,
      mime_type: file.type || "application/octet-stream",
      last_modified: file.lastModified,
      md5: hashValues?.md5 || "",
      sha1: hashValues?.sha1 || "",
      sha256: hashValues?.sha256 || "",
    },
    {
      headers: {
        "File-Path": encodeURIComponent(uploadPath),
        Overwrite: overwrite.toString(),
        Password: pwd,
      },
      signal,
    },
  )

  if (createResp.code !== 200) {
    if (isCancelledResp(createResp)) {
      throwUploadCancelled()
    }
    throw new Error(
      createResp.message || "Failed to create chunked upload session",
    )
  }

  const uploadId: string = createResp.data.upload_id
  const chunkSize: number = createResp.data.chunk_size || requestedChunkSize
  const totalChunks: number =
    createResp.data.total_chunks || Math.ceil(file.size / chunkSize)
  let uploadedBytes = 0
  let oldTimestamp = Date.now()
  let oldLoaded = 0

  try {
    // Step 2: Upload each chunk with retry
    for (let i = 0; i < totalChunks; i++) {
      if (signal?.aborted) {
        throwUploadCancelled()
      }

      const start = i * chunkSize
      const end = Math.min(start + chunkSize, file.size)
      const chunk = file.slice(start, end)
      let retries = 0

      while (true) {
        const chunkResp: any = await r.put("/fs/chunked/upload", chunk, {
          headers: {
            "Upload-Id": uploadId,
            "Chunk-Index": String(i),
            "Content-Type": "application/octet-stream",
            Password: pwd,
          },
          signal,
          onUploadProgress: (progressEvent) => {
            if (progressEvent.total) {
              const totalLoaded = uploadedBytes + progressEvent.loaded
              const progress = ((totalLoaded / file.size) * 100) | 0
              setUpload("progress", progress)

              const timestamp = Date.now()
              const duration = (timestamp - oldTimestamp) / 1000
              if (duration > 1) {
                const loaded = totalLoaded - oldLoaded
                const speed = loaded / duration
                setUpload("speed", speed)
                oldTimestamp = timestamp
                oldLoaded = totalLoaded
              }
            }
          },
        })

        if (chunkResp.code === 200) {
          uploadedBytes += end - start
          break // chunk succeeded, move to next
        }

        if (isCancelledResp(chunkResp)) {
          throwUploadCancelled()
        }

        // Retry on transient errors with exponential backoff
        if (isTransient(chunkResp) && retries < MAX_RETRIES) {
          retries++
          oldLoaded = uploadedBytes
          const backoff = INITIAL_RETRY_DELAY_MS * 2 ** (retries - 1)
          await delay(backoff, signal)
          continue
        }

        // Non-transient error or retries exhausted
        throw new Error(
          chunkResp.message ||
            `Failed to upload chunk ${i + 1}/${totalChunks}` +
              (retries > 0 ? ` after ${retries} retries` : ""),
        )
      }
    }

    // Step 3: Complete — merge all chunks and write to storage
    setUpload("status", "backending")
    const completeResp: any = await r.post(
      "/fs/chunked/complete",
      { upload_id: uploadId, as_task: asTask },
      { headers: { Password: pwd }, signal },
    )

    if (completeResp.code !== 200) {
      if (isCancelledResp(completeResp)) {
        throwUploadCancelled()
      }
      // Abort to clean up server-side temp files on complete failure
      await abortSession(uploadId, pwd)
      throw new Error(
        completeResp.message || "Failed to complete chunked upload",
      )
    }
  } catch (err) {
    if (isCancelledError(err) || signal?.aborted) {
      await abortSession(uploadId, pwd)
      throwUploadCancelled()
    }
    await abortSession(uploadId, pwd)
    throw err
  }
}

// Helper: abort a chunked upload session (fire-and-forget, swallows errors)
async function abortSession(uploadId: string, pwd: string): Promise<void> {
  await r
    .post(
      "/fs/chunked/abort",
      { upload_id: uploadId },
      { headers: { Password: pwd } },
    )
    .catch(() => {})
}

// Standard single-request upload: sends entire file via PUT /fs/put
const SingleUpload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  asTask: boolean,
  overwrite: boolean,
  headers: { [k: string]: any },
  signal?: AbortSignal,
): Promise<void> => {
  let oldTimestamp = Date.now()
  let oldLoaded = 0

  const resp: EmptyResp = await r.put("/fs/put", file, {
    headers: headers,
    signal,
    onUploadProgress: (progressEvent) => {
      if (progressEvent.total) {
        const complete =
          ((progressEvent.loaded / progressEvent.total) * 100) | 0
        setUpload("progress", complete)

        const timestamp = Date.now()
        const duration = (timestamp - oldTimestamp) / 1000
        if (duration > 1) {
          const loaded = progressEvent.loaded - oldLoaded
          const speed = loaded / duration
          setUpload("speed", speed)

          oldTimestamp = timestamp
          oldLoaded = progressEvent.loaded
        }

        if (complete === 100) {
          setUpload("status", "backending")
        }
      }
    },
  })
  if (resp.code !== 200) {
    if (isCancelledResp(resp)) {
      throwUploadCancelled()
    }
    throw new Error(resp.message)
  }
}

// StreamUpload: auto-detects file size and switches to chunked upload when needed.
// When chunked upload is enabled in settings and the file reaches the configured
// threshold, the file is split into chunks and uploaded via /fs/chunked/* endpoints.
// Otherwise falls back to standard single-request PUT /fs/put.
export const StreamUpload: Upload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  asTask = false,
  overwrite = false,
  rapid = false,
  signal?: AbortSignal,
): Promise<undefined> => {
  // Compute hashes if rapid upload is requested (used by both paths)
  let hashValues: { md5: string; sha1: string; sha256: string } | undefined
  if (rapid) {
    setUpload("status", "hashing")
    hashValues = await calculateHash(
      file,
      (p) => {
        setUpload("progress", p | 0)
      },
      signal,
    )
    if (signal?.aborted) {
      throwUploadCancelled()
    }
  }

  setUpload("status", "uploading")

  // Check if chunked upload should be used
  const chunkedEnabled = getSettingBool("enable_chunked_upload")
  const chunkSizeBytes = getChunkSizeBytes()

  if (chunkedEnabled && file.size >= chunkSizeBytes) {
    await ChunkedUpload(
      uploadPath,
      file,
      setUpload,
      asTask,
      overwrite,
      hashValues,
      signal,
    )
  } else {
    // Build headers for standard upload
    const headers: { [k: string]: any } = {
      "File-Path": encodeURIComponent(uploadPath),
      "As-Task": asTask.toString(),
      "Content-Type": file.type || "application/octet-stream",
      "Last-Modified": file.lastModified,
      Password: password(),
      Overwrite: overwrite.toString(),
    }
    if (hashValues) {
      headers["X-File-Md5"] = hashValues.md5
      headers["X-File-Sha1"] = hashValues.sha1
      headers["X-File-Sha256"] = hashValues.sha256
    }
    await SingleUpload(
      uploadPath,
      file,
      setUpload,
      asTask,
      overwrite,
      headers,
      signal,
    )
  }
}
