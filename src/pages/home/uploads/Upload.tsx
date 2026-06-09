import {
  VStack,
  Input,
  Heading,
  HStack,
  IconButton,
  Checkbox,
  Text,
  Badge,
  Progress,
  ProgressIndicator,
  Button,
  Box,
  Stack,
} from "@hope-ui/solid"
import { createSignal, For, Show } from "solid-js"
import { usePath, useRouter, useT } from "~/hooks"
import { getMainColor, uploadConfig, setUploadConfig } from "~/store"
import {
  RiDocumentFolderUploadFill,
  RiDocumentFileUploadFill,
} from "solid-icons/ri"
import { getFileSize, notify, pathJoin } from "~/utils"
import { asyncPool } from "~/utils/async_pool"
import { createStore } from "solid-js/store"
import { UploadFileProps, StatusBadge } from "./types"
import { File2Upload, traverseFileTree } from "./util"
import { SelectWrapper } from "~/components"
import { getUploads } from "./uploads"

// Terminal statuses for filtering "done" uploads
const TERMINAL = new Set(["success", "error", "cancelled"])
const ACTIVE = new Set(["pending", "hashing", "uploading", "backending"])

type UploadJob = {
  file: File
  upload: UploadFileProps
}

const UploadFile = (props: UploadFileProps & { onCancel?: () => void }) => {
  const t = useT()
  const isActive = () => ACTIVE.has(props.status)
  return (
    <VStack
      w="$full"
      spacing="$1"
      rounded="$lg"
      border="1px solid $neutral7"
      alignItems="start"
      p="$2"
      _hover={{
        border: `1px solid ${getMainColor()}`,
      }}
    >
      <HStack w="$full" justifyContent="space-between">
        <Text css={{ wordBreak: "break-all", flex: 1 }}>{props.path}</Text>
        <Show when={isActive()}>
          <Button
            size="xs"
            colorScheme="danger"
            variant="ghost"
            onClick={() => props.onCancel?.()}
          >
            {t("home.upload.cancel")}
          </Button>
        </Show>
      </HStack>
      <HStack spacing="$2" w="$full" justifyContent="space-between">
        <HStack spacing="$2">
          <Badge colorScheme={StatusBadge[props.status]}>
            {t(`home.upload.${props.status}`)}
          </Badge>
          <Text>{getFileSize(props.speed)}/s</Text>
        </HStack>
        <Text color="$neutral11">{getFileSize(props.size)}</Text>
      </HStack>
      <Progress
        w="$full"
        trackColor="$info3"
        rounded="$full"
        value={props.progress}
        size="sm"
      >
        <ProgressIndicator color={getMainColor()} rounded="$md" />
      </Progress>
      <Text color="$danger10">{props.msg}</Text>
    </VStack>
  )
}

const Upload = () => {
  const t = useT()
  const { pathname } = useRouter()
  const { refresh } = usePath()
  const [drag, setDrag] = createSignal(false)
  const [uploading, setUploading] = createSignal(false)
  const [uploadFiles, setUploadFiles] = createStore<{
    uploads: UploadFileProps[]
  }>({
    uploads: [],
  })

  // Per-file AbortControllers for cancellation support
  const abortControllers = new Map<string, AbortController>()

  const allDone = () => {
    return uploadFiles.uploads.every(({ status }) => TERMINAL.has(status))
  }
  let fileInput!: HTMLInputElement
  let folderInput!: HTMLInputElement
  const handleAddFiles = async (files: File[]) => {
    if (files.length === 0) return
    setUploading(true)
    const jobs = files.map((file) => ({
      file,
      upload: File2Upload(file),
    }))
    setUploadFiles("uploads", (uploads) => [
      ...uploads,
      ...jobs.map(({ upload }) => upload),
    ])
    for await (const ms of asyncPool(3, jobs, handleFile)) {
      console.log(ms)
    }
    refresh()
    // 再次延迟刷新一次，以便能看到后端异步生成的 BT 文件（如 189/189pc 驱动的 .cas.torrent）
    setTimeout(() => refresh(undefined, true), 5000)
  }
  const setUpload = (id: string, key: keyof UploadFileProps, value: any) => {
    setUploadFiles("uploads", (upload) => upload.id === id, key, value)
  }

  const cancelUpload = (id: string) => {
    const ctrl = abortControllers.get(id)
    if (ctrl) {
      ctrl.abort()
      abortControllers.delete(id)
    }
  }

  // All upload methods are available by default
  const uploaders = getUploads()
  const [curUploader, setCurUploader] = createSignal(uploaders[0])
  const handleFile = async ({ file, upload }: UploadJob) => {
    const { id, path } = upload
    const controller = new AbortController()
    abortControllers.set(id, controller)

    setUpload(id, "status", "uploading")
    const uploadPath = pathJoin(pathname(), path)
    try {
      const err = await curUploader()
        .upload(
          uploadPath,
          file,
          (key, value) => {
            setUpload(id, key, value)
          },
          uploadConfig.asTask,
          uploadConfig.overwrite,
          uploadConfig.rapid,
          controller.signal,
        )
        .catch((err) => err)
      if (!err) {
        setUpload(id, "status", "success")
        setUpload(id, "progress", 100)
      } else if (err.message === "Upload cancelled") {
        setUpload(id, "status", "cancelled")
      } else {
        setUpload(id, "status", "error")
        setUpload(id, "msg", err.message)
      }
    } catch (e: any) {
      if (e?.message === "Upload cancelled") {
        setUpload(id, "status", "cancelled")
      } else {
        console.error(e)
        setUpload(id, "status", "error")
        setUpload(id, "msg", e.message)
      }
    } finally {
      abortControllers.delete(id)
    }
  }
  return (
    <VStack w="$full" pb="$2" spacing="$2">
      <Show
        when={!uploading()}
        fallback={
          <>
            <HStack spacing="$2">
              <Button
                colorScheme="accent"
                onClick={() => {
                  setUploadFiles("uploads", (_uploads) =>
                    _uploads.filter(({ status }) => !TERMINAL.has(status)),
                  )
                }}
              >
                {t("home.upload.clear_done")}
              </Button>
              <Show when={allDone()}>
                <Button
                  onClick={() => {
                    setUploading(false)
                  }}
                >
                  {t("home.upload.back")}
                </Button>
              </Show>
            </HStack>
            <For each={uploadFiles.uploads}>
              {(upload) => (
                <UploadFile
                  {...upload}
                  onCancel={() => cancelUpload(upload.id)}
                />
              )}
            </For>
          </>
        }
      >
        <Input
          type="file"
          multiple
          ref={fileInput}
          display="none"
          onChange={(e) => {
            // @ts-ignore
            handleAddFiles(Array.from(e.target.files ?? []))
          }}
        />
        <Input
          type="file"
          multiple
          // @ts-ignore
          webkitdirectory
          ref={folderInput}
          display="none"
          onChange={(e) => {
            // @ts-ignore
            handleAddFiles(Array.from(e.target.files ?? []))
          }}
        />
        <VStack
          w="$full"
          justifyContent="center"
          border={`2px dashed ${drag() ? getMainColor() : "$neutral8"}`}
          rounded="$lg"
          spacing="$4"
          p="$6"
          minH="$56"
          onDragOver={(e: DragEvent) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => {
            setDrag(false)
          }}
          onDrop={async (e: DragEvent) => {
            e.preventDefault()
            e.stopPropagation()
            setDrag(false)
            const res: File[] = []
            const items = Array.from(e.dataTransfer?.items ?? [])
            const files = Array.from(e.dataTransfer?.files ?? [])
            let itemLength = items.length
            const folderEntries = []
            for (let i = 0; i < itemLength; i++) {
              const item = items[i]
              const entry = item.webkitGetAsEntry()
              if (entry?.isFile) {
                res.push(files[i])
              } else if (entry?.isDirectory) {
                folderEntries.push(entry)
              }
            }
            for (const entry of folderEntries) {
              const innerFiles = await traverseFileTree(entry)
              res.push(...innerFiles)
            }
            if (res.length === 0) {
              notify.warning(t("home.upload.no_files_drag"))
            }
            handleAddFiles(res)
          }}
        >
          <Show
            when={!drag()}
            fallback={<Heading>{t("home.upload.release")}</Heading>}
          >
            <Heading size="lg" textAlign="center">
              {t("home.upload.upload-tips")}
            </Heading>
            <Box w={{ "@initial": "80%", "@md": "30%" }}>
              <SelectWrapper
                value={curUploader()?.name}
                onChange={(name) => {
                  setCurUploader(
                    uploaders.find((uploader) => uploader.name === name)!,
                  )
                }}
                options={uploaders.map((uploader) => {
                  return {
                    label: uploader.name,
                    value: uploader.name,
                  }
                })}
              />
            </Box>
            <HStack spacing="$4">
              <VStack spacing="$2" alignItems="center">
                <IconButton
                  compact
                  size="xl"
                  aria-label={t("home.upload.upload_folder")}
                  colorScheme="accent"
                  icon={<RiDocumentFolderUploadFill size="1.2em" />}
                  onClick={() => {
                    folderInput.click()
                  }}
                />
                <Text fontSize="$sm" color="$neutral11" textAlign="center">
                  {t("home.upload.upload_folder")}
                </Text>
              </VStack>

              <VStack spacing="$2" alignItems="center">
                <IconButton
                  compact
                  size="xl"
                  aria-label={t("home.upload.upload_files")}
                  icon={<RiDocumentFileUploadFill size="1.2em" />}
                  onClick={() => {
                    fileInput.click()
                  }}
                />
                <Text fontSize="$sm" color="$neutral11" textAlign="center">
                  {t("home.upload.upload_files")}
                </Text>
              </VStack>
            </HStack>
            <Stack
              spacing={{ "@initial": "$2", "@md": "$4" }}
              direction={{ "@initial": "column", "@md": "row" }}
            >
              <Checkbox
                checked={uploadConfig.asTask}
                onChange={() => {
                  setUploadConfig({ asTask: !uploadConfig.asTask })
                }}
              >
                {t("home.upload.add_as_task")}
              </Checkbox>
              <Checkbox
                checked={uploadConfig.overwrite}
                onChange={() => {
                  setUploadConfig({ overwrite: !uploadConfig.overwrite })
                }}
              >
                {t("home.conflict_policy.overwrite_existing")}
              </Checkbox>
              <Checkbox
                checked={uploadConfig.rapid}
                onChange={() => {
                  setUploadConfig({ rapid: !uploadConfig.rapid })
                }}
              >
                {t("home.upload.try_rapid")}
              </Checkbox>
            </Stack>
          </Show>
        </VStack>
      </Show>
    </VStack>
  )
}

export default Upload
