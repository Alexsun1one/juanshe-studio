import { cn } from '@/lib/utils'

// 与全站手写骨架统一:同一条 .skel 暖纸微光(design.css),不再各养一套。
// 圆角由 .skel 提供 var(--r-sm);要更大圆角/尺寸由调用处 className 叠加。
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="skeleton" className={cn('skel', className)} {...props} />
  )
}

export { Skeleton }
