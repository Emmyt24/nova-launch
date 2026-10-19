import { IsEnum, IsOptional, IsArray, IsInt, IsString, Min } from "class-validator";
import { Transform, Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";

export enum TokenInclude {
  METADATA = "metadata",
  BURNS = "burns",
  ANALYTICS = "analytics",
}

export class GetTokenQueryDto {
  @ApiPropertyOptional({
    description: "Additional data to include in response",
    enum: TokenInclude,
    isArray: true,
    example: ["metadata", "burns", "analytics"],
  })
  @IsOptional()
  @IsArray()
  @IsEnum(TokenInclude, { each: true })
  @Transform(({ value }) => {
    if (typeof value === "string") return [value];
    return value;
  })
  include?: TokenInclude[];
}

export class GetTokenCreationFeeQuoteQueryDto {
  @ApiPropertyOptional({
    description: "Number of tokens to be created (affects per-token fee)",
    minimum: 1,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  tokenCount?: number;

  @ApiPropertyOptional({
    description: "Whether metadata will be attached to the token (affects metadata fee)",
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
    }
    return value;
  })
  withMetadata?: boolean;

  @ApiPropertyOptional({
    description: "Optional token symbol used for creation (may affect validation fees)",
    example: "TKN",
  })
  @IsOptional()
  @IsString()
  symbol?: string;
}