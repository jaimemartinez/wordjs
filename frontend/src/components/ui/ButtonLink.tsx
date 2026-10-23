"use client";

import React from "react";
import Link from "next/link";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./Button";

export interface ButtonLinkProps extends Omit<React.ComponentProps<typeof Link>, "className"> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: string;
    className?: string;
}

/** ButtonLink — navigation that looks like a Button (a real link: middle-click, open in new tab). */
export function ButtonLink({ variant = "secondary", size = "md", icon, className = "", children, ...props }: ButtonLinkProps) {
    return (
        <Link {...props} className={`${buttonClasses(variant, size)} ${className}`}>
            {icon && <i className={`fa-solid ${icon} text-[11px]`} aria-hidden="true"></i>}
            {children && <span>{children}</span>}
        </Link>
    );
}

export default ButtonLink;
