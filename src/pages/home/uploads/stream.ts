import { password, getSettingBool, getSettingNumber } from "~/store"
import { EmptyResp } from "~/types"
import { r } from "~/utils"
import { SetUpload, Upload } from "./types"
import { calculateHash } from "./util"

// Chunked upload: split file into chunks and upload via /fs/chunked/* endpoints.
// Automatically bypasses reverse proxy body size limits (Cloudflare 100MB, etc.)
const ChunkedUpload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  asTask: boolean,
  overwrite: boolean,
  hashValues?: { md5: string; sha1: string; sha256: string },
): Promise<void> => {
  const chunkSizeMB = getSettingNumber("chunked_upload_size", 50)
  const chunkSize = chunkSizeMB * 1024 * 1024
  const totalChunks = Math.ceil(file.size / chunkSize)
  const pwd = password()

  // Step 1: Create session
  const createResp: any = await r.post(
    "/fs/chunked/create",
    {
      size: file.size,
      chunk_size: chunkSize,
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
    },
  )

  if (createResp.code !== 200) {
    throw new Error(
      createResp.message || "Failed to create chunked upload session",
    )
  }

  const uploadId: string = createResp.data.upload_id
  let uploadedBytes = 0
  let oldTimestamp = Date.now()
  let oldLoaded = 0

  // Step 2: Upload each chunk
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize, file.size)
    const chunk = file.slice(start, end)

    const chunkResp: any = await r.put("/fs/chunked/upload", chunk, {
      headers: {
        "Upload-Id": uploadId,
        "Chunk-Index": String(i),
        "Content-Type": "application/octet-stream",
        Password: pwd,
      },
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

    if (chunkResp.code !== 200) {
      // Abort the session on failure to clean up server-side temp files
      await r
        .post(
          "/fs/chunked/abort",
          { upload_id: uploadId },
          { headers: { Password: pwd } },
        )
        .catch(() => {})
      throw new Error(
        chunkResp.message || `Failed to upload chunk ${i + 1}/${totalChunks}`,
      )
    }

    uploadedBytes += end - start
  }

  // Step 3: Complete — merge all chunks and write to storage
  setUpload("status", "backending")
  const completeResp: any = await r.post(
    "/fs/chunked/complete",
    { upload_id: uploadId, as_task: asTask },
    { headers: { Password: pwd } },
  )

  if (completeResp.code !== 200) {
    // Abort to clean up server-side temp files on complete failure
    await r
      .post(
        "/fs/chunked/abort",
        { upload_id: uploadId },
        { headers: { Password: pwd } },
      )
      .catch(() => {})
    throw new Error(completeResp.message || "Failed to complete chunked upload")
  }
}

// Standard single-request upload: sends entire file via PUT /fs/put
const SingleUpload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  asTask: boolean,
  overwrite: boolean,
  headers: { [k: string]: any },
): Promise<void> => {
  let oldTimestamp = Date.now()
  let oldLoaded = 0

  const resp: EmptyResp = await r.put("/fs/put", file, {
    headers: headers,
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
          const remain = progressEvent.total - progressEvent.loaded
          const remainTime = remain / speed
          setUpload("speed", speed)
          console.log(remainTime)

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
    throw new Error(resp.message)
  }
}

// StreamUpload: auto-detects file size and switches to chunked upload when needed.
// When chunked upload is enabled in settings and the file exceeds the configured
// threshold, the file is split into chunks and uploaded via /fs/chunked/* endpoints.
// Otherwise falls back to standard single-request PUT /fs/put.
export const StreamUpload: Upload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  asTask = false,
  overwrite = false,
  rapid = false,
): Promise<undefined> => {
  // Compute hashes if rapid upload is requested (used by both paths)
  let hashValues: { md5: string; sha1: string; sha256: string } | undefined
  if (rapid) {
    setUpload("status", "hashing")
    hashValues = await calculateHash(file, (p) => {
      setUpload("progress", p | 0)
    })
  }

  setUpload("status", "uploading")

  // Check if chunked upload should be used
  const chunkedEnabled = getSettingBool("enable_chunked_upload")
  const chunkSizeMB = getSettingNumber("chunked_upload_size", 50)
  const chunkSizeBytes = chunkSizeMB * 1024 * 1024

  if (chunkedEnabled && file.size > chunkSizeBytes) {
    await ChunkedUpload(
      uploadPath,
      file,
      setUpload,
      asTask,
      overwrite,
      hashValues,
    )
  } else {
    // Build headers for standard upload
    const headers: { [k: string]: any } = {
      "File-Path": encodeURIComponent(uploadPath),
      "As-Task": asTask,
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
    await SingleUpload(uploadPath, file, setUpload, asTask, overwrite, headers)
  }
}
