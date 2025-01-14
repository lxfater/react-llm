import { detectGPUDevice } from "@/worker/lib/tvm";
import { InitProgressReport } from "@/worker/lib/tvm/runtime";
import * as Comlink from "comlink";
import { Remote } from "comlink";
import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { Conversation } from "../types/chat";
import {
  GenerateTextRequest,
  GenerateTextResponse,
  ModelWorker,
} from "../types/worker_message";
import useConversationStore, {
  defaultSystemPrompt,
} from "./useConversationStore";
import useStore from "./useStore";

export type UseLLMParams = {
  autoInit?: boolean;
};

const initialProgress = {
  type: "init" as const,
  progress: 0,
  timeElapsed: 0,
  currentChunk: 0,
  totalChunks: 0,
  fetchedBytes: 0,
  totalBytes: 0,
};

export type GPUDeviceInfo = {
  adapter: GPUAdapter | null;
  device: GPUDevice | null;
  adapterInfo: GPUAdapterInfo | null;
  checked: boolean;
  unsupportedReason: string | null;
};

export type UseLLMResponse = {
  // Conversation returns the current conversation object.
  conversation: Conversation | undefined;

  // AllConversations returns all conversations sorted by updatedAt.
  allConversations: Conversation[] | undefined;

  // LoadingStatus returns the current loading status.
  loadingStatus: InitProgressReport;

  // IsGenerating returns whether the model is currently generating. Concurrent generation is not supported.
  isGenerating: boolean;

  // CreateConversation creates a new conversation and sets it as the current conversation.
  createConversation: (title?: string, prompt?: string) => void;

  // SetConversationId sets the current conversation id.
  setConversationId: (conversationId: string) => void;

  // DeleteConversation deletes a conversation.
  deleteConversation: (conversationId: string) => void;

  // DeleteAllConversations deletes all conversations.
  deleteAllConversations: () => void;

  // DeleteMessages deletes all messages in the current conversation.
  deleteMessages: () => void;

  // SetConversationTitle sets the title of a conversation.
  setConversationTitle: (conversationId: string, title: string) => void;

  // OnMessage returns the current onMessage callback.
  onMessage: (msg: GenerateTextResponse) => void;

  // SetOnMessage sets the onMessage callback. This callback is called whenever a new message is generated by the model.
  setOnMessage: (cb: (msg: GenerateTextResponse) => void) => void;

  // UserRoleName returns the current user role name. The default is "user".
  userRoleName: string;

  // SetUserRoleName sets the user role name.
  setUserRoleName: (roleName: string) => void;

  // AssistantRoleName returns the current assistant role name. The default is "assistant".
  assistantRoleName: string;

  // SetAssistantRoleName sets the assistant role name.
  setAssistantRoleName: (roleName: string) => void;

  // GpuDevice returns the current GPU device info. If GPU is not supported, this will return an object with unsupportedReason set.
  gpuDevice: GPUDeviceInfo;

  // Send sends a message to the model for generation.
  send: (text: string, maxToken: number, stopSequences: string[]) => void;

  // Init initializes the model.
  init: () => void;
};

export const useLLMContext = (): UseLLMResponse => {
  const [loadingStatus, setLoadingStatus] =
    useState<InitProgressReport>(initialProgress);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const workerRef = useRef<Remote<ModelWorker>>();
  const cStore = useStore(useConversationStore, (state) => state);
  const [userRoleName, setUserRoleName] = useState<string>("user");
  const [assistantRoleName, setAssistantRoleName] =
    useState<string>("assistant");

  const [gpuDevice, setGpuDevice] = useState<GPUDeviceInfo>({
    adapter: null,
    device: null,
    adapterInfo: null,
    checked: false,
    unsupportedReason: null,
  });

  useEffect(() => {
    if (!gpuDevice || !gpuDevice.checked) {
      detectGPUDevice()
        .then((resp) => {
          if (resp) {
            setGpuDevice({
              unsupportedReason: null,
              checked: true,
              adapter: resp.adapter,
              device: resp.device,
              adapterInfo: resp.adapterInfo,
            });
          } else {
            setGpuDevice({
              ...gpuDevice,
              checked: true,
              unsupportedReason: "GPU is not supported",
            });
          }
        })
        .catch((err) => {
          setGpuDevice({
            adapter: null,
            device: null,
            adapterInfo: null,
            checked: true,
            unsupportedReason: err.message,
          });
        });
    }
  }, []);

  const [onMessage, setOnMessage] = useState<any>();

  const addMessage = useCallback(
    (resp: GenerateTextResponse) => {
      if (resp.isFinished) {
        setIsGenerating(false);
      }
      if (onMessage) onMessage(resp);
      cStore?.addMessage(cStore?.currentConversationId, {
        id: resp.requestId,
        createdAt: new Date().getTime(),
        updatedAt: new Date().getTime(),
        role: assistantRoleName,
        text: resp.outputText,
      });
    },
    [cStore, cStore?.currentConversationId, onMessage, setOnMessage]
  );

  useEffect(() => {
    if (!workerRef.current) {
      workerRef.current = Comlink.wrap(
        new Worker(new URL("../worker/worker", import.meta.url))
      );
    }
  }, []);

  const send = (
    text: string,
    maxTokens = 100,
    stopStrings = [userRoleName, assistantRoleName] as string[]
  ) => {
    const currentConversation = cStore?.getConversation(
      cStore?.currentConversationId
    );
    if (!currentConversation) {
      throw new Error("Invalid conversation id");
    }
    currentConversation?.messages.push({
      id: uuidv4(),
      createdAt: new Date().getTime(),
      updatedAt: new Date().getTime(),
      role: userRoleName,
      text,
    });
    setIsGenerating(true);
    workerRef?.current?.generate(
      {
        conversation: currentConversation,
        stopTexts: stopStrings,
        maxTokens,
        assistantRoleName,
      } as GenerateTextRequest,
      Comlink.proxy(addMessage)
    );
  };

  return {
    conversation: cStore?.getConversation(cStore?.currentConversationId),

    allConversations: cStore?.conversations.sort(
      (a: Conversation, b: Conversation) => b.updatedAt - a.updatedAt
    ),

    createConversation: (title?: string, prompt?: string) => {
      const id = uuidv4();
      cStore?.createConversation({
        id,
        title: title ?? "Untitled",
        systemPrompt: prompt ?? defaultSystemPrompt,
        messages: [],
        createdAt: new Date().getTime(),
        updatedAt: new Date().getTime(),
      });
    },

    setConversationTitle: (id: string, title: string) => {
      cStore?.setConversationTitle(id, title);
    },

    setConversationId: (id: string) => {
      cStore?.setConversationId(id);
    },

    deleteConversation: (id: string) => {
      cStore?.deleteConversation(id);
    },
    deleteMessages: () => cStore?.deleteMessages(cStore?.currentConversationId),

    onMessage,
    setOnMessage,

    loadingStatus,
    isGenerating,

    userRoleName,
    setUserRoleName,

    assistantRoleName,
    setAssistantRoleName,

    gpuDevice,

    send,
    init: () => workerRef?.current?.init(Comlink.proxy(setLoadingStatus)),

    deleteAllConversations: () => cStore?.deleteAllConversations(),
  };
};
