"use client";

import Link, { LinkProps } from "next/link";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";
import { MouseEvent, ReactNode } from "react";

interface SmartLinkProps extends LinkProps, Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps> {
    children: ReactNode;
    className?: string;
    onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}

export default function SmartLink({ children, onClick, ...props }: SmartLinkProps) {
    const { checkAndNavigate } = useUnsavedChanges();

    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
        if (onClick) onClick(e);

        if (!e.defaultPrevented) {
            e.preventDefault();
            checkAndNavigate(props.href as string);
        }
    };

    return (
        <Link {...props} onClick={handleClick} href={props.href as string}>
            {children}
        </Link>
    );
}
