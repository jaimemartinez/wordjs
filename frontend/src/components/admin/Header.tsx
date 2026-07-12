import React from 'react';

interface HeaderProps {
    title: string;
    description?: string;
    actions?: React.ReactNode;
}

const Header = ({ title, description, actions }: HeaderProps) => {
    return (
        <div className="flex flex-wrap justify-between items-center gap-y-3 mb-6 px-8 pt-8">
            <div>
                <h1 className="text-2xl font-bold text-gray-800">{title}</h1>
                {description && <p className="text-sm text-gray-500 mt-1">{description}</p>}
            </div>
            {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
    );
};

export default Header;
