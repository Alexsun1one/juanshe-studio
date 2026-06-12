'use client'

// 旧 radix toast 已退役:全站只留 sonner 一条 toast 通道(ui/sonner.tsx 挂根布局)。
// 此前这里是一套自带内存 store 的 react-hot-toast 仿写,但它的渲染端(旧 ui/toaster)
// 从未挂载——13+ 个业务组件的 toast 调用全部静默丢失。现在保留旧签名做薄适配,
// 业务零改动直接落到 sonner:variant "destructive" → error,其余走默认暖纸卡。

import * as React from 'react'
import { toast as sonnerToast } from 'sonner'

type ToastInput = {
  title?: React.ReactNode
  description?: React.ReactNode
  variant?: 'default' | 'destructive'
  duration?: number
}

function toast({ title, description, variant, duration }: ToastInput) {
  const fire = variant === 'destructive' ? sonnerToast.error : sonnerToast
  const id = fire(title ?? '', { description, duration })
  return { id, dismiss: () => sonnerToast.dismiss(id) }
}

function useToast() {
  return {
    toast,
    dismiss: (toastId?: string | number) => sonnerToast.dismiss(toastId),
  }
}

export { useToast, toast }
