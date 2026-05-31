import { useId } from 'react'

interface LogoSvgProps {
  size?: number
  animated?: boolean
  status?: 'idle' | 'thinking' | 'executing' | 'typing'
  className?: string
}

export default function LogoSvg({ size = 32, animated = false, status = 'idle', className = '' }: LogoSvgProps) {
  const uid = useId().replace(/:/g, '')
  const animClass = animated ? `logo-${status}` : ''

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`logo-orb ${animClass} ${className}`}
    >
      <defs>
        <radialGradient id={`orb${uid}`} cx="35%" cy="25%">
          <stop offset="0%" stopColor="#FFD54A" />
          <stop offset="20%" stopColor="#FF9A1F" />
          <stop offset="50%" stopColor="#FF2F92" />
          <stop offset="80%" stopColor="#C026FF" />
          <stop offset="100%" stopColor="#6D28FF" />
        </radialGradient>
        <radialGradient id={`glass${uid}`} cx="30%" cy="20%">
          <stop offset="0%" stopColor="white" stopOpacity={0.85} />
          <stop offset="100%" stopColor="white" stopOpacity={0} />
        </radialGradient>
        <linearGradient id={`rim${uid}`}>
          <stop offset="0%" stopColor="#FFE5B8" />
          <stop offset="50%" stopColor="#FF6CCF" />
          <stop offset="100%" stopColor="#A855F7" />
        </linearGradient>
        <filter id={`glow${uid}`}>
          <feGaussianBlur stdDeviation="18" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Outer glow */}
      <circle cx="256" cy="256" r="170" fill="#FF4FAE" opacity={0.45} filter={`url(#glow${uid})`} />
      {/* Main orb */}
      <circle cx="256" cy="256" r="160" fill={`url(#orb${uid})`} />
      {/* Rim */}
      <circle cx="256" cy="256" r="160" fill="none" stroke={`url(#rim${uid})`} strokeWidth="3" opacity={0.9} />
      {/* Glass highlight */}
      <ellipse cx="215" cy="195" rx="95" ry="65" fill={`url(#glass${uid})`} opacity={0.7} />
      {/* Bottom shine */}
      <ellipse cx="250" cy="350" rx="115" ry="45" fill="white" opacity={0.12} />
      {/* Left eye */}
      <rect className="logo-eye" x="205" y="175" width="52" height="95" rx="26" fill="white" opacity={0.95} />
      {/* Right eye */}
      <rect className="logo-eye" x="295" y="165" width="52" height="95" rx="26" fill="white" opacity={0.95} />
    </svg>
  )
}
